// Gate R-PACOTE — o Omni Harness é instalável por npm/pnpx, brew e curl (R-distribuição).
// Contratos: package.json publicável (bin, engines >= 22, allowlist `files` existente), CLI vivo
// (`--version`, `init --help`) e o fluxo `pnpm dlx` de ponta a ponta: `init` semeia hospedeiro
// a partir do PACOTE (mesmo caminho do registry), não do scripts/ da raiz.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoRoot } from '../lib/util.mjs';

const ROOT = repoRoot();
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const BIN = path.join(ROOT, PKG.bin['omni-harness']);

test('pacote npm: nome, engines >= 22, type module e bin existente', () => {
  assert.equal(PKG.name, 'omni-harness');
  assert.match(PKG.version, /^\d+\.\d+\.\d+$/);
  assert.match(PKG.engines.node, /^>=\s*22/);
  assert.equal(PKG.type, undefined, 'raiz SEM "type": hooks sem extensão (.clinerules/hooks) herdam o package.json e quebrariam como ESM');
  const hooksPkg = JSON.parse(fs.readFileSync(path.join(ROOT, '.clinerules', 'hooks', 'package.json'), 'utf8'));
  assert.equal(hooksPkg.type, 'commonjs', 'escopo CJS local dos hooks do Cline');
  assert.ok(fs.existsSync(BIN), 'bin/omni-harness.mjs deve existir');
});

test('allowlist `files`: toda entrada existe no repo e nenhuma vaza dado de produto', () => {
  for (const entry of PKG.files) {
    const abs = path.join(ROOT, entry.replace(/\/\*\*$/, ''));
    assert.ok(fs.existsSync(abs), `files: "${entry}" não existe no repo`);
  }
  assert.ok(!PKG.files.some((f) => f.startsWith('quality/examples')), 'exemplo do Exemplo SaaS não vai no pacote npm');
  assert.ok(!PKG.files.includes('docs/parking-lot/**'), 'parking-lot é decisão interna, não vai no pacote');
});

test('CLI vivo: --version imprime a versão do pacote; init --help responde', () => {
  const v = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(v.status, 0);
  assert.match(v.stdout, new RegExp(`${PKG.name} ${PKG.version}`));
  const h = spawnSync(process.execPath, [BIN, 'init', '--help'], { encoding: 'utf8', timeout: 30_000 });
  assert.match(h.stdout, /omni-harness init <destino>/);
});

test('pnpm-dlx de ponta a ponta: bin init semeia hospedeiro a partir do pacote', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-init-'));
  try {
    const r = spawnSync(process.execPath, [BIN, 'init', tmp, '--nome', 'via-dlx'], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const perfil = path.join(tmp, 'quality', 'profile', 'via-dlx.json');
    assert.ok(fs.existsSync(perfil), 'perfil stub gerado');
    const stub = JSON.parse(fs.readFileSync(perfil, 'utf8'));
    assert.equal(stub.name, 'via-dlx');
    assert.equal(stub.tracker.provider, 'none');
    assert.ok(fs.existsSync(path.join(tmp, 'scripts', 'tracker', 'sync-context.mjs')), 'tracker runtime incluído');
    const sync = spawnSync(process.execPath, [path.join(tmp, 'quality', 'agents', 'sync-clinerules.mjs'), '--check'], { cwd: tmp, encoding: 'utf8', timeout: 30_000 });
    assert.equal(sync.status, 0, sync.stderr);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
