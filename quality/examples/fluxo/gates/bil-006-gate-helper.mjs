// Helper dos gates BIL-006: leitura estrutural de HCL, `terraform validate` local e execução real da API.
// Nunca roda `plan` nem `apply`, não lê `.tfvars` nem `.env*` e não fala com GCP ou PSP.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT } from './bil-gate-helper.mjs';

const tail = (text, lines = 40) => text.split('\n').slice(-lines).join('\n');

// ── HCL ───────────────────────────────────────────────────────────────────────

/** Remove comentários HCL, preservando o que estiver dentro de strings. */
export function stripComments(source) {
  let out = '';
  let inString = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += source[i + 1] ?? ''; i += 1; } else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '#' || (ch === '/' && source[i + 1] === '/')) {
      while (i < source.length && source[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2) + 1;
      if (i === 0) break;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Devolve o texto entre o delimitador em `open` e o seu par, ignorando o conteúdo de strings. */
function balanced(source, open) {
  const [start, end] = source[open] === '{' ? ['{', '}'] : ['[', ']'];
  let depth = 0;
  let inString = false;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === start) depth += 1;
    else if (ch === end) {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`delimitador sem par: ${source.slice(open, open + 60)}`);
}

/** Corpos dos blocos cujo cabeçalho casa com `header`. */
export function blocks(source, header) {
  const re = new RegExp(`(?:^|\\n)\\s*${header}\\s*\\{`, 'g');
  const found = [];
  for (const match of source.matchAll(re)) found.push(balanced(source, match.index + match[0].length - 1));
  return found;
}

export const resources = (source, type, name = '[\\w-]+') => blocks(source, `resource\\s+"${type}"\\s+"${name}"`);

/** Expressão de um atributo: vai até o fim da linha com todos os delimitadores fechados. Aceita condicional com objeto. */
export function attribute(body, name) {
  const match = body.match(new RegExp(`(?:^|\\n)[ \\t]*"?${name}"?[ \\t]*=[ \\t]*`));
  if (!match) return undefined;
  const start = match.index + match[0].length;
  let depth = 0;
  let inString = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if ('{[('.includes(ch)) depth += 1;
    else if ('}])'.includes(ch)) depth -= 1;
    else if (ch === '\n' && depth === 0) return body.slice(start, i).trim();
  }
  return body.slice(start).trim();
}

/** Expande `local.<nome>` com a definição do local, para aceitar env declarado em `locals`. */
export function expandLocals(text, source) {
  const definitions = blocks(source, 'locals').join('\n');
  let out = text;
  const seen = new Set();
  for (let again = true; again;) {
    again = false;
    for (const [, name] of out.matchAll(/\blocal\.(\w+)/g)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const value = attribute(definitions, name);
      if (value !== undefined) { out += `\n${value}`; again = true; }
    }
  }
  return out;
}

// ── terraform ─────────────────────────────────────────────────────────────────

function pluginDir() {
  const candidates = ['infra/gcp/terraform/environments/prod/.terraform/providers', 'infra/gcp/terraform/.terraform/providers'];
  return candidates.map((rel) => path.join(ROOT, rel)).find((dir) => fs.existsSync(dir));
}

/**
 * `terraform validate` numa cópia temporária só com `.tf` e lock versionados: sem backend, sem `.tfvars`
 * e sem tocar o `.terraform` do repositório. Usa os providers já baixados quando existem.
 */
export function terraformValidate(dirs) {
  const version = spawnSync('terraform', ['version'], { encoding: 'utf8' });
  assert.equal(version.error, undefined, `terraform indisponível: ${version.error?.message}`);
  const listed = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '--', 'infra/gcp/terraform'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(listed.status, 0, `git ls-files falhou: ${listed.stderr}`);
  const files = listed.stdout.split('\n').filter((f) => /(\.tf|\.terraform\.lock\.hcl)$/.test(f) && fs.existsSync(path.join(ROOT, f)));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bil-006-tf-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TF_VAR_|TF_CLI_ARGS|TF_WORKSPACE|GOOGLE_|CLOUDSDK_)/.test(k)));
  const plugins = pluginDir();
  try {
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(tmp, file)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, file), path.join(tmp, file));
    }
    for (const dir of dirs) {
      const cwd = path.join(tmp, dir);
      const init = spawnSync('terraform', ['init', '-backend=false', '-input=false', '-no-color', ...(plugins ? [`-plugin-dir=${plugins}`] : [])],
        { cwd, env, encoding: 'utf8', timeout: 45_000 });
      assert.equal(init.status, 0, `terraform init falhou em ${dir}:\n${tail(`${init.stdout}\n${init.stderr}`)}`);
      const check = spawnSync('terraform', ['validate', '-json', '-no-color'], { cwd, env, encoding: 'utf8', timeout: 45_000, maxBuffer: 16 * 1024 * 1024 });
      assert.ok(check.stdout, `terraform validate sem saída em ${dir}:\n${tail(check.stderr ?? '')}`);
      const report = JSON.parse(check.stdout);
      const errors = (report.diagnostics ?? []).filter((d) => d.severity === 'error').map((d) => `${d.summary}: ${d.detail ?? ''}`);
      assert.deepEqual(errors, [], `terraform validate reprovou ${dir}`);
      assert.equal(report.valid, true, `terraform validate reprovou ${dir}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── API real ──────────────────────────────────────────────────────────────────

const API_PROJECT = 'backend/src/Fluxo.Api/Fluxo.Api.csproj';
const API_DLL = path.join(ROOT, 'backend/src/Fluxo.Api/bin/Debug/net10.0/Fluxo.Api.dll');
let built = false;

/** Compila uma vez por execução, para nunca provar o contrato com um binário antigo. */
export function buildApi() {
  if (built) return;
  const r = spawnSync('dotnet', ['build', API_PROJECT, '-c', 'Debug', '--nologo', '-v', 'q'],
    { cwd: ROOT, encoding: 'utf8', timeout: 90_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(r.error, undefined, `dotnet build não executou: ${r.error?.message}`);
  assert.equal(r.status, 0, `dotnet build falhou:\n${tail(`${r.stdout}\n${r.stderr}`)}`);
  assert.ok(fs.existsSync(API_DLL), `binário ausente: ${API_DLL}`);
  built = true;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const portOpen = (port) => new Promise((resolve) => {
  const socket = net.connect({ port, host: '127.0.0.1' });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});

/**
 * Sobe `dotnet Fluxo.Api.dll` com ambiente mínimo e HOME vazio: sem credencial, sem `.env`, banco em porta fechada.
 * Com `stopWhenOpen`, encerra assim que a porta abre (controle de que a sonda enxerga o Kestrel).
 */
export async function runApi(args, { environment, waitMs, stopWhenOpen = false, env = {} }) {
  const port = await freePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bil-006-home-'));
  const ca = path.join(home, 'gate-ca.pem');
  fs.writeFileSync(ca, 'gate\n');
  const child = spawn('dotnet', [API_DLL, ...args], {
    cwd: path.dirname(API_DLL),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH, HOME: home, TMPDIR: home,
      ...(process.env.DOTNET_ROOT ? { DOTNET_ROOT: process.env.DOTNET_ROOT } : {}),
      ASPNETCORE_ENVIRONMENT: environment,
      ASPNETCORE_URLS: `http://127.0.0.1:${port}`,
      Database__Host: '127.0.0.1', Database__Port: '1', Database__Name: 'gate', Database__Username: 'gate',
      Database__Password: 'gate-sem-valor', Database__SslMode: 'VerifyCA', Database__RootCertificate: ca,
      Billing__Enabled: 'false',
      ...env,
    },
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  let exit = null;
  const exited = new Promise((resolve) => child.once('close', (code, signal) => { exit = { code, signal }; resolve(); }));
  const spawnError = new Promise((resolve) => child.once('error', (error) => { log += `\n${error.message}`; exit ??= { code: -1, signal: null }; resolve(); }));
  const deadline = Date.now() + waitMs;
  let opened = false;
  while (!exit && Date.now() < deadline && !(stopWhenOpen && opened)) {
    opened = (await portOpen(port)) || opened;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const timedOut = !exit;
  if (timedOut) {
    child.kill('SIGKILL');
    await Promise.race([exited, spawnError]);
  }
  fs.rmSync(home, { recursive: true, force: true });
  return { code: timedOut ? null : exit.code, timedOut, opened, log };
}
