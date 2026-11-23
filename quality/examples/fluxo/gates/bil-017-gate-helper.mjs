// Helper dos gates BIL-017: JDK, emuladores descartáveis em portas livres e Functions compiladas do fonte atual.
// Projeto demo-*: o firebase-tools não usa credencial nem fala com produção. Sem JDK 21+ o gate falha, não pula.
// functions/lib é versionado: o gate compila para uma pasta temporária em functions/ e nunca toca lib/.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { ROOT } from './bil-gate-helper.mjs';

export const PROJECT = 'demo-bil017';
export const DATABASE = 'fluxo';
export const RULES = path.join(ROOT, 'firestore.rules');
const DEADLINE_MS = 100_000;
export const functionsRequire = createRequire(path.join(ROOT, 'functions/package.json'));
export const siteRequire = createRequire(path.join(ROOT, 'ofluxo_site/package.json'));

const tail = (text, lines = 25) => text.split('\n').slice(-lines).join('\n');

function javaMajor(home) {
  const r = spawnSync(path.join(home, 'bin/java'), ['-version'], { encoding: 'utf8' });
  const match = /version "(\d+)/.exec(`${r.stdout}\n${r.stderr}`);
  return match ? Number(match[1]) : 0;
}

/** JAVA_HOME se for 21+, senão /usr/libexec/java_home. O java padrão da máquina é o 17, que o firebase-tools recusa. */
export function javaEnv() {
  const candidates = [process.env.JAVA_HOME];
  const finder = spawnSync('/usr/libexec/java_home', ['-v', '21+'], { encoding: 'utf8' });
  if (finder.status === 0) candidates.push(finder.stdout.trim());
  const home = candidates.find((dir) => dir && javaMajor(dir) >= 21);
  assert.ok(home, `JDK 21+ não encontrado (JAVA_HOME=${process.env.JAVA_HOME ?? ''}); o gate falha em vez de pular`);
  return { JAVA_HOME: home, PATH: `${home}/bin:${process.env.PATH}` };
}

export const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

/** Sobe `services` (firestore, auth), chama fn({ firestore, auth }) e encerra tudo, inclusive em falha. */
export async function withEmulators(services, fn) {
  const env = javaEnv();
  const [firestore, websocket, auth, hub, logging] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bil-017-emu-'));
  const config = path.join(dir, 'firebase.json');
  fs.writeFileSync(config, JSON.stringify({
    firestore: { rules: RULES, database: DATABASE },
    emulators: {
      singleProjectMode: true, ui: { enabled: false }, hub: { host: '127.0.0.1', port: hub }, logging: { host: '127.0.0.1', port: logging },
      firestore: { host: '127.0.0.1', port: firestore, websocketPort: websocket }, auth: { host: '127.0.0.1', port: auth },
    },
  }));
  const child = spawn('firebase', ['emulators:start', '--only', services.join(','), '--project', PROJECT, '--config', config], {
    cwd: dir, env: { ...process.env, ...env, CI: '1', GCLOUD_PROJECT: PROJECT }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let log = '';
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const force = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* já saiu */ } }, 6_000);
    child.once('exit', () => { clearTimeout(force); resolve(); });
    try { process.kill(-child.pid, 'SIGTERM'); } catch { clearTimeout(force); resolve(); }
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`emuladores não subiram em 45 s:\n${tail(log)}`)), 45_000);
      const read = (chunk) => {
        log += chunk;
        if (log.includes('All emulators ready')) { clearTimeout(timer); resolve(); }
      };
      child.stdout.on('data', read);
      child.stderr.on('data', read);
      child.once('error', (error) => { clearTimeout(timer); reject(new Error(`firebase não executou: ${error.message}`)); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`emuladores saíram com ${code}:\n${tail(log)}`)); });
    });
    // Abaixo dos 120 s do eval.mjs: estourar aqui ainda encerra os emuladores; ser morto pelo eval deixaria processo órfão.
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`cenário passou de ${DEADLINE_MS / 1000} s`)), DEADLINE_MS); });
    return await Promise.race([fn({ firestore: `127.0.0.1:${firestore}`, auth: `127.0.0.1:${auth}`, firestorePort: firestore, authPort: auth }), deadline]).finally(() => clearTimeout(timer));
  } finally {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Compila functions/src para functions/.gate-bil017-<pid>/ e devolve { lib, cleanup }. */
export function compileFunctions() {
  const name = `.gate-bil017-${process.pid}`;
  const out = path.join(ROOT, 'functions', name);
  const r = spawnSync(path.join(ROOT, 'functions/node_modules/.bin/tsc'), ['-p', 'tsconfig.json', '--outDir', name], {
    cwd: path.join(ROOT, 'functions'), encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
  });
  const cleanup = () => fs.rmSync(out, { recursive: true, force: true });
  if (r.status !== 0) {
    cleanup();
    assert.fail(`tsc das Functions falhou:\n${tail(`${r.stdout}\n${r.stderr}`)}`);
  }
  return { lib: out, cleanup };
}

/** Handlers reais de Fluxo Empresas contra o emulador. Só chamar com o emulador de pé: o Admin SDK lê o ambiente ao carregar. */
export function loadHandlers(lib, { firestore, auth }) {
  assert.match(firestore, /^127\.0\.0\.1:/, 'handlers só rodam contra o emulador local');
  process.env.FIRESTORE_EMULATOR_HOST = firestore;
  if (auth) process.env.FIREBASE_AUTH_EMULATOR_HOST = auth;
  process.env.GCLOUD_PROJECT = PROJECT;
  process.env.FIRESTORE_DATABASE_ID = DATABASE;
  const { db } = functionsRequire(path.join(lib, 'shared/firebase.js'));
  const handlers = functionsRequire(path.join(lib, 'features/fluxo_empresas.js'));
  const call = (name, uid, data) => handlers[name].run({ auth: { uid, token: {} }, data });
  return { db, call };
}

/** Falha do callable vira código HttpsError, para o cenário comparar. */
export const codeOf = (promise) => promise.then(() => 'ok', (error) => String(error?.code ?? error?.message ?? error));

export function gitHead() {
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
}

/** Reúne desvios sem parar no primeiro: o gate relata todos, e o baseline mostra o motivo real de cada falha. */
export function collector() {
  const failures = [];
  return {
    failures,
    check: (label, ok, detail = '') => { if (!ok) failures.push(detail ? `${label}: ${detail}` : label); },
    done: () => assert.deepEqual(failures, [], 'desvios do contrato'),
  };
}
