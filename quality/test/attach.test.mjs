// Gate R4-ACOPLAMENTO: `harness-init` semeia um núcleo UTILIZÁVEL num repo hospedeiro novo —
// perfil stub carrega com o nome do projeto, sync-clinerules fica em sincronia e o hook
// post-edit responde num arquivo .ts genérico (sem nenhum path de produto).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoRoot } from '../lib/util.mjs';

const SRC = repoRoot();

test('R4: harness-init semeia perfil carregável, sync em sincronia e hook vivo no hospedeiro novo', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-'));
  try {
    const init = spawnSync(process.execPath, [path.join(SRC, 'scripts', 'harness-init.mjs'), tmp, '--nome', 'fixture'], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(init.status, 0, `init falhou: ${init.stderr}`);

    // 1) perfil stub carrega com o nome do projeto e zero erros de schema:
    const prof = spawnSync(process.execPath, ['-e', "import('./quality/lib/profile.mjs').then(m => console.log([m.PROFILE.name, m.PROFILE.locale, m.PROFILE_ERRORS.length].join('|')))"], { cwd: tmp, encoding: 'utf8', timeout: 30_000 });
    assert.match(prof.stdout.trim(), /^fixture\|pt-BR\|0$/, prof.stderr);

    // 2) sync-clinerules do hospedeiro em sincronia (índice 80 + overlay 85):
    const sync = spawnSync(process.execPath, [path.join(tmp, 'quality', 'agents', 'sync-clinerules.mjs'), '--check'], { cwd: tmp, encoding: 'utf8', timeout: 30_000 });
    assert.equal(sync.status, 0, `sync --check falhou: ${sync.stderr}`);
    assert.ok(fs.existsSync(path.join(tmp, '.clinerules', '85-projeto.md')), 'overlay espelhado');
    assert.ok(!fs.existsSync(path.join(tmp, 'quality', 'config', 'layers.json')), 'configs de produto não vazam para o host novo');

    // 3) hook post-edit vivo no hospedeiro: resposta 0 num .ts genérico (sem git, falha aberta).
    const hook = spawnSync(process.execPath, [path.join(tmp, 'quality', 'hooks', 'post-edit.mjs')], {
      cwd: tmp, encoding: 'utf8', timeout: 60_000,
      input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(tmp, 'src', 'app.ts'), content: 'export const x = 1;\n' } }),
    });
    assert.equal(hook.status, 0, `post-edit falhou: ${hook.stderr}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('R4-total: nível rápido COMPLETO no fixture com git (commit limpo → APROVADO)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-git-'));
  try {
    const init = spawnSync(process.execPath, [path.join(SRC, 'scripts', 'harness-init.mjs'), tmp, '--nome', 'fixture-git'], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(init.status, 0, init.stderr);
    // git: init, identidade mínima e commit de toda a árvore (.gitignore copiado cobre node_modules)
    for (const cmd of [
      ['git', ['init']],
      ['git', ['config', 'user.email', 'fixture@harness.local']],
      ['git', ['config', 'user.name', 'fixture']],
      ['git', ['add', '-A']],
      ['git', ['commit', '-m', 'chore: semente do hospedeiro', '--no-verify', '--no-gpg-sign']],
    ]) {
      const g = spawnSync(cmd[0], cmd[1], { cwd: tmp, encoding: 'utf8', timeout: 60_000 });
      assert.equal(g.status, 0, `git ${cmd[1][0]} falhou: ${g.stderr}`);
    }
    // Nível rápido da suíte: árvore limpa → gates do diff vazios → APROVADO.
    const run = spawnSync(process.execPath, [path.join(tmp, 'quality', 'run.mjs'), '--tier', 'rapido'], { cwd: tmp, encoding: 'utf8', timeout: 120_000 });
    assert.equal(run.status, 0, `nível rápido falhou (exit ${run.status}):\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout + run.stderr, /APROVADO|nenhum arquivo alterado para avaliar/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}, { timeout: 180_000 });
