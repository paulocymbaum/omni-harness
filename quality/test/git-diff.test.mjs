// Gate EG1 (docs/parking-lot/big-o-easy-gains.md): collectEntries monta added/removed com
// UM `git diff -U0` global em vez de mkdtemp+spawn+rm por arquivo — mesmos vereditos do
// caminho antigo, O(n) spawns a menos por rodada de gates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.mjs';
import { collectEntries, diffGlobal, fileAtRev, fileAtRevBatch, headSha } from '../lib/git.mjs';

test('diffGlobal: hunks de vários arquivos num único Map (novo caminho b/)', () => {
  const repo = tempRepo({ 'a.txt': 'l1\nl2\nl3\n', 'dir/b.txt': 'x\n' });
  try {
    repo.write('a.txt', 'l1\nL2 mudou\nl3\nl4\n');
    fs.rmSync(path.join(repo.dir, 'dir'), { recursive: true, force: true });
    const mapa = diffGlobal(repo.dir, headSha(repo.dir));
    const a = mapa.get('a.txt');
    assert.ok(a, 'a.txt no Map');
    assert.deepEqual(a.added.map((x) => [x.line, x.text]), [[2, 'L2 mudou'], [4, 'l4']]);
    assert.deepEqual(a.removed, ['l2']);
    assert.ok(mapa.has('dir/b.txt'), 'deleção entra no Map pelo caminho novo');
    assert.deepEqual(mapa.get('dir/b.txt').removed, ['x']);
  } finally {
    repo.cleanup();
  }
});

test('fileAtRevBatch == fileAtRev para presente, ausente e não-commitado', () => {
  const repo = tempRepo({ 'a.txt': 'um\ndois\n', 'dir/b.txt': 'conteúdo b çãã\n' });
  try {
    repo.write('a.txt', 'um\ndois\ntrês\n');
    const rev = headSha(repo.dir);
    const pedidos = ['a.txt', 'dir/b.txt', 'nao-existe.txt'];
    const lote = fileAtRevBatch(rev, pedidos, repo.dir);
    for (const p of pedidos) {
      assert.equal(lote.get(p), fileAtRev(rev, p, repo.dir), `batch == unitário para ${p}`);
    }
    assert.ok(lote.get('a.txt').includes('dois'));
    assert.ok(lote.get('dir/b.txt').includes('çãã'), 'UTF-8 multibyte intacto no parse por bytes');
    assert.equal(lote.get('nao-existe.txt'), null);
  } finally {
    repo.cleanup();
  }
});

test('collectEntries: modified/deleted/untracked com added/removed corretos (1 diff global)', () => {
  const repo = tempRepo({ 'a.txt': 'l1\nl2\nl3\n', 'dir/b.txt': 'x\n' });
  try {
    repo.write('a.txt', 'l1\nL2 mudou\nl3\nl4\n');
    fs.rmSync(path.join(repo.dir, 'dir'), { recursive: true, force: true });
    repo.write('c.txt', 'novo1\nnovo2\n');
    const entries = collectEntries({ root: repo.dir, base: 'HEAD' });
    const porPath = new Map(entries.map((e) => [e.path, e]));
    const a = porPath.get('a.txt');
    assert.deepEqual(a.added.map((x) => [x.line, x.text]), [[2, 'L2 mudou'], [4, 'l4']]);
    assert.deepEqual(a.removed, ['l2']);
    assert.ok(a.oldText.includes('l2') && a.newText.includes('L2 mudou'));
    const b = porPath.get('dir/b.txt');
    assert.equal(b.status, 'D');
    assert.equal(b.newText, null);
    assert.deepEqual(b.removed, ['x']);
    const c = porPath.get('c.txt');
    assert.equal(c.status, 'A');
    assert.deepEqual(c.added.map((x) => x.text), ['novo1', 'novo2']);
    assert.deepEqual(c.removed, []);
  } finally {
    repo.cleanup();
  }
});
