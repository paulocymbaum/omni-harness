// Servidor do site para BIL-017-FLUXO-COMPLETO. Usa o Vite do site, em porta própria, com envDir vazio: nenhum .env* é lido.
// cacheDir próprio: o cache padrão fica em node_modules/.vite, compartilhado com o servidor de desenvolvimento do usuário.
// firebase.ts fixa as portas de emulador; o plugin troca só esses números, em memória, pelas portas descartáveis do gate.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { BIL_SITE: site, BIL_ENV_DIR: envDir, BIL_PORT: port, BIL_FIRESTORE_PORT: firestore, BIL_AUTH_PORT: auth } = process.env;
const { createServer } = await import(pathToFileURL(path.join(site, 'node_modules/vite/dist/node/index.js')).href);

const ports = {
  name: 'bil-017-emulator-ports',
  enforce: 'pre',
  transform(code, id) {
    if (!id.split('?')[0].endsWith('/platform/infrastructure/firebase.ts')) return null;
    const out = code.replace("'http://127.0.0.1:9099'", `'http://127.0.0.1:${auth}'`).replace("'127.0.0.1', 8081", `'127.0.0.1', ${firestore}`);
    if (out === code) throw new Error('firebase.ts sem as portas de emulador esperadas');
    return out;
  },
};

const server = await createServer({
  configFile: path.join(site, 'vite.config.ts'), root: site, envDir, mode: 'development', logLevel: 'warn', plugins: [ports], cacheDir: path.join(envDir, 'vite-cache'),
  server: { host: '127.0.0.1', port: Number(port), strictPort: true },
});
await server.listen();
console.log('BIL017_SITE_READY');
process.on('SIGTERM', () => { void server.close().finally(() => process.exit(0)); });
