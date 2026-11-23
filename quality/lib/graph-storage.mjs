// Onde o grafo do graphify fica de verdade e como o link `graphify-out` se mantém de pé.
// O grafo mora FORA da árvore (`~/.cache/fluxo-graph/<hash do repo>/graphify-out`) e `graphify-out/`
// é só um symlink: assim `graphify query` e o guard seguem achando o grafo sem flags, e um
// `git clean` ou o `checkpoint restore` do Cline (que já apagou o link) só remove o atalho, nunca
// os 60 MB do grafo. `healGraphLink` recria o atalho sozinho quando o grafo ainda existe no cache.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** FLUXO_GRAPH_DIR=in-tree mantém o diretório dentro do repo; outro valor muda a base do cache. */
export function graphStorageDir(root, env = process.env) {
  const base = env.FLUXO_GRAPH_DIR || path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'fluxo-graph');
  return path.join(base, createHash('sha1').update(root).digest('hex').slice(0, 12), 'graphify-out');
}

/** Garante o symlink `graphify-out` → armazenamento externo. Diretório real legado é mantido. */
export function ensureGraphLink(root, env = process.env) {
  if (env.FLUXO_GRAPH_DIR === 'in-tree') return { mode: 'in-tree' };
  const link = path.join(root, 'graphify-out');
  let stat = null;
  try { stat = fs.lstatSync(link); } catch { /* ainda não existe */ }
  if (stat && !stat.isSymbolicLink()) return { mode: 'in-tree' };
  const target = graphStorageDir(root, env);
  fs.mkdirSync(target, { recursive: true });
  if (stat && fs.readlinkSync(link) === target) return { mode: 'link', target, created: false };
  if (stat) fs.unlinkSync(link); // symlink apontando para outro lugar
  fs.symlinkSync(target, link, 'dir');
  return { mode: 'link', target, created: true };
}

/**
 * Recria o link quando ele sumiu mas o grafo ainda está no cache. Só age se existir
 * `graph.json` lá (nunca cria diretório vazio) e se não houver nada em `graphify-out`.
 * Devolve true quando recriou.
 */
export function healGraphLink(root, env = process.env) {
  if (env.FLUXO_GRAPH_DIR === 'in-tree') return false;
  const link = path.join(root, 'graphify-out');
  try { fs.lstatSync(link); return false; } catch { /* sumiu: tenta reparar */ }
  const target = graphStorageDir(root, env);
  if (!fs.existsSync(path.join(target, 'graph.json'))) return false;
  try { fs.symlinkSync(target, link, 'dir'); return true; } catch { return false; }
}
