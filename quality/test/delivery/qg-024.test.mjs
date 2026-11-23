// Gate QG-024 — chave dura GH_ACTIONS=false: nenhuma chamada a gh; só scripts locais.
// Estratégia black-box: um `gh` falso no PATH que registra toda invocação num arquivo-sentinela e
// falha (exit 99). Com a chave desligada, a sentinela NÃO pode existir (nenhum subprocesso gh);
// com GH_ACTIONS=true, a sentinela prova que o caminho antigo continua funcionando.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const RAIZ = resolve(new URL('../../..', import.meta.url).pathname);
const PASTA = mkdtempSync(join(tmpdir(), 'qg024-'));
const SENTINELA = join(PASTA, 'gh-chamadas.log');
const PATH_FALSO = `${join(PASTA, 'bin')}:${process.env.PATH}`;

mkdirSync(join(PASTA, 'bin'), { recursive: true });
writeFileSync(
  join(PASTA, 'bin', 'gh'),
  '#!/usr/bin/env bash\necho "gh $*" >> "$SENTINELA"\nexit 99\n',
  { mode: 0o755 },
);

function rodar(args, envExtra = {}) {
  return spawnSync('node', args, {
    cwd: RAIZ,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, PATH: PATH_FALSO, SENTINELA, GH_ACTIONS: '', ...envExtra },
  });
}

const ghFoiChamado = () => existsSync(SENTINELA);
const limpaSentinela = () => rmSync(SENTINELA, { force: true });

test('actions-quota --check desligado: veredito DESLIGADO, exit 1, nenhum gh', () => {
  limpaSentinela();
  const r = rodar(['scripts/deploy/actions-quota.mjs', '--check']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /DESLIGADO/);
  assert.match(r.stdout, /GH_ACTIONS=false/);
  assert.equal(ghFoiChamado(), false, 'gh não pode ser invocado com a chave desligada');
});

test('actions-quota --json desligado: desligado=true e credito=null sem gh', () => {
  limpaSentinela();
  const r = rodar(['scripts/deploy/actions-quota.mjs', '--json']);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.desligado, true);
  assert.equal(payload.credito, null);
  assert.equal(ghFoiChamado(), false);
});

test('GH_ACTIONS=true preserva o caminho antigo: gh é chamado (sentinela registra)', () => {
  limpaSentinela();
  const r = rodar(['scripts/deploy/actions-quota.mjs', '--check'], { GH_ACTIONS: 'true' });
  assert.equal(r.status, 1, 'gh falso falha de propósito: veredito inconclusivo → local');
  assert.match(r.stdout, /INCONCLUSIVO/);
  assert.equal(ghFoiChamado(), true, 'com a chave ligada, o gh continua no caminho');
});

test('release.mjs --probe desligado: DESLIGADO, exit 1, nenhum gh', () => {
  limpaSentinela();
  const r = rodar(['scripts/deploy/release.mjs', '--probe']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /DESLIGADO/);
  assert.equal(ghFoiChamado(), false);
});

test('release.mjs --run de passo de Actions, sem --local, é recusado com instrução local', () => {
  limpaSentinela();
  const r = rodar(['scripts/deploy/release.mjs', '--run', 'deploy-web']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--run deploy-web --local/);
  assert.equal(ghFoiChamado(), false);
});

test('release.mjs --plan desligado: plano sai sem nenhuma consulta de status ao gh', () => {
  limpaSentinela();
  const r = rodar(['scripts/deploy/release.mjs', '--plan']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /deploy-api/);
  assert.equal(ghFoiChamado(), false);
});

test('gh-actions.mjs: default é false (hardcoded) e GH_ACTIONS=true religa', () => {
  const off = spawnSync('node', ['-e', "console.log((await import('./scripts/deploy/gh-actions.mjs')).GH_ACTIONS_ENABLED)"], {
    cwd: RAIZ, encoding: 'utf8', env: { ...process.env, GH_ACTIONS: '' },
  });
  assert.equal(off.stdout.trim(), 'false');
  const on = spawnSync('node', ['--input-type=module', '-e', "console.log((await import('./scripts/deploy/gh-actions.mjs')).GH_ACTIONS_ENABLED)"], {
    cwd: RAIZ, encoding: 'utf8', env: { ...process.env, GH_ACTIONS: 'true' },
  });
  assert.equal(on.stdout.trim(), 'true');
});

test('sentinela ilegível não vira aprovação: recusa de passo monitor também vale', () => {
  limpaSentinela();
  const r = rodar(['scripts/deploy/release.mjs', '--run', 'main-merge']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--run main-merge --local/);
  assert.equal(ghFoiChamado(), false);
});

test('limpeza', () => {
  rmSync(PASTA, { recursive: true, force: true });
  assert.ok(!existsSync(SENTINELA));
});
