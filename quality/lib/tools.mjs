import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './util.mjs';
import { stripLiterals } from './sanitize.mjs';
import { timeFactor } from './limits.mjs';

/** Procura um executável no PATH sem executá-lo (rápido e sem efeitos colaterais). */
export function which(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch { /* continua */ }
  }
  return null;
}

let lizardCmd;

/** lizard instalado, ou via `uvx --offline` (cache local, sem rede). null se indisponível. */
export function lizardCommand() {
  if (lizardCmd !== undefined) return lizardCmd;
  if (process.env.QUALITY_NO_LIZARD === '1') return (lizardCmd = null);
  if (which('lizard') && run('lizard', ['--version'], { timeoutMs: 10_000 }).code === 0) return (lizardCmd = ['lizard']);
  if (which('uvx') && run('uvx', ['--offline', 'lizard', '--version'], { timeoutMs: 20_000 }).code === 0) {
    return (lizardCmd = ['uvx', '--offline', 'lizard']);
  }
  return (lizardCmd = null);
}

/** Baixa o lizard para o cache do uv (usado no SessionStart, com rede). */
export function warmLizard() {
  if (which('lizard') || !which('uvx')) return;
  run('uvx', ['lizard', '--version'], { timeoutMs: 60_000 });
  lizardCmd = undefined;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * Métricas por função via lizard (CSV): nloc, ccn, tokens, params, length, location, file, function, long_name, start, end.
 * Devolve null se o lizard não estiver disponível.
 */
function parseLizardEntry(f, halstead) {
  const entry = {
    nloc: Number(f[0]), ccn: Number(f[1]), params: Number(f[3]),
    file: f[6], name: f[7], longName: f[8], start: Number(f[9]), end: Number(f[10]),
  };
  if (halstead) { entry.hVolume = Number(f[11]); entry.hDifficulty = Number(f[12]); }
  return entry;
}

/** Timeout de uma medição por texto; QUALITY_LIZARD_TIMEOUT_MS ajusta (máquina lenta ou teste). Escala com os limites. */
const textTimeoutMs = () => (Number(process.env.QUALITY_LIZARD_TIMEOUT_MS) || 30_000) * timeFactor();

export function lizardFunctions(files, { cwd, timeoutMs = 120_000 * timeFactor(), halstead = false } = {}) {
  const cmd = lizardCommand();
  if (!cmd) return null;
  const extraArgs = halstead ? ['-Ehalstead'] : [];
  const minLen = halstead ? 14 : 11;
  const out = [];
  for (let i = 0; i < files.length; i += 400) {
    const chunk = files.slice(i, i + 400);
    const r = run(cmd[0], [...cmd.slice(1), '--csv', ...extraArgs, ...chunk], { cwd, timeoutMs });
    if (r.timedOut) return null;
    for (const line of r.stdout.split('\n')) {
      if (!line.trim()) continue;
      const f = parseCsvLine(line);
      if (f.length < minLen || Number.isNaN(Number(f[1]))) continue;
      out.push(parseLizardEntry(f, halstead));
    }
  }
  return out;
}

/**
 * Escolhe, por arquivo, entre a análise do texto original e a do texto sanitizado.
 * Quando um parse quebra (aspas em regex, JSX…), funções se fundem: fica a versão que separa
 * mais funções e, no empate, a sanitizada. Determinístico.
 */
function pickPerFile(raw, sanitized) {
  const group = (fns) => {
    const m = new Map();
    for (const f of fns ?? []) { if (!m.has(f.file)) m.set(f.file, []); m.get(f.file).push(f); }
    return m;
  };
  const a = group(raw);
  const b = group(sanitized);
  const out = [];
  for (const file of new Set([...a.keys(), ...b.keys()])) {
    const r = a.get(file) ?? [];
    const s = b.get(file) ?? [];
    out.push(...(r.length > s.length ? r : s));
  }
  return out;
}

function writeTree(dir, files, contentOf) {
  for (const f of files) {
    const text = contentOf(f);
    if (text == null) continue;
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
}

function lizardBoth(files, contentOf, languageOf, timeoutMs, halstead = false) {
  const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qliz-raw-'));
  const sanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qliz-san-'));
  try {
    writeTree(rawDir, files, contentOf);
    writeTree(sanDir, files, (f) => stripLiterals(contentOf(f), languageOf(f)));
    const raw = lizardFunctions(files, { cwd: rawDir, timeoutMs, halstead });
    const san = lizardFunctions(files, { cwd: sanDir, timeoutMs, halstead });
    if (raw == null || san == null) return raw ?? san;
    return pickPerFile(raw, san);
  } finally {
    fs.rmSync(rawDir, { recursive: true, force: true });
    fs.rmSync(sanDir, { recursive: true, force: true });
  }
}

/** Métricas por função de um texto (arquivo temporário com a mesma extensão). */
export function lizardOnText(text, ext, lang) {
  if (text == null) return [];
  const name = `src${ext}`;
  return lizardBoth([name], () => text, () => lang, textTimeoutMs());
}

/** Igual a lizardOnText, mas inclui Halstead (hVolume, hDifficulty) em cada função. */
export function lizardHalsteadOnText(text, ext, lang) {
  if (text == null) return [];
  const name = `src${ext}`;
  return lizardBoth([name], () => text, () => lang, textTimeoutMs(), true);
}

/** Métricas por função de arquivos do repositório (mesmos caminhos relativos na saída). */
export function lizardOnFiles(root, files, languageOf, { halstead = false } = {}) {
  const read = (f) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return null; } };
  return lizardBoth(files, read, languageOf, 600_000, halstead);
}

export function toolInventory() {
  return {
    lizard: Boolean(lizardCommand()),
    dart: Boolean(which('dart')),
    flutter: Boolean(which('flutter')),
    dotnet: Boolean(which('dotnet')),
    pnpm: Boolean(which('pnpm')),
    uv: Boolean(which('uv')),
    docker: Boolean(which('docker')),
    firebase: Boolean(which('firebase')),
    'osv-scanner': Boolean(which('osv-scanner')),
  };
}
