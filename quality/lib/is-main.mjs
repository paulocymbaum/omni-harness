// "Este arquivo é o ponto de entrada?" para scripts ESM. O padrão `import.meta.url ===
// file://${process.argv[1]}` falha em silêncio com espaço no caminho (a URL codifica o espaço,
// o argv não), com Windows e com symlink: o script vira um no-op que sai com 0. Aqui os dois
// lados são resolvidos para o caminho real antes de comparar.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** `isMain(import.meta.url)` no topo do script que precisa saber se foi executado direto. */
export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  return real(argv1) === real(fileURLToPath(metaUrl));
}
