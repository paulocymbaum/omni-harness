import path from 'node:path';
import { readJson, repoRoot, run } from '../util.mjs';

function loopback(host = '127.0.0.1') {
  return ['localhost', '127.0.0.1', '0.0.0.0'].includes(host) ? '127.0.0.1' : null;
}

function validPort(port) {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

/** O runner é síncrono; a consulta limitada ao hub roda em um subprocesso Node. */
function emulatorFromHub(url) {
  const script = `
    try {
      const response = await fetch(process.argv[1], { signal: AbortSignal.timeout(1000) });
      if (!response.ok) process.exit(1);
      const services = await response.json();
      process.stdout.write(JSON.stringify(services.firestore ?? null));
    } catch { process.exit(1); }
  `;
  const response = run(process.execPath, ['--input-type=module', '-e', script, url], { timeoutMs: 2_000 });
  if (response.code !== 0) return null;
  try { return JSON.parse(response.stdout); } catch { return null; }
}

/** Nunca inicia emuladores nem substitui uma variável de ambiente explícita. */
export function backendTestEnvironment({ root = repoRoot(), env = process.env, probe = emulatorFromHub } = {}) {
  if (env.FIRESTORE_EMULATOR_HOST?.trim()) return { FIRESTORE_EMULATOR_HOST: env.FIRESTORE_EMULATOR_HOST };
  const config = readJson(path.join(root, 'firebase.json'), {}).emulators;
  const firestore = config?.firestore;
  const host = loopback(firestore?.host);
  const hubHost = loopback(config?.hub?.host);
  const hubPort = config?.hub?.port ?? 4400;
  if (!firestore || !host || !hubHost || !validPort(firestore.port) || !validPort(hubPort)) return undefined;
  const running = probe(`http://${hubHost}:${hubPort}/emulators`);
  if (!running || typeof running.host !== 'string' || loopback(running.host) !== host || running.port !== firestore.port) return undefined;
  return { FIRESTORE_EMULATOR_HOST: `${host}:${firestore.port}` };
}
