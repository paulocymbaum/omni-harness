// Árvore limpa nos níveis pesados (rotina/completo): escopo vazio é ALERTA explícito,
// não aprovação sem medição (anti-force-pass). Rode: node --test quality/test/escopo-vazio.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempRepo, runScript } from './helpers.mjs';

test('run.mjs: tier completo em árvore limpa marca escopo vazio como ALERTA', () => {
  const repo = tempRepo();
  try {
    const r = runScript(repo, 'run.mjs', null, ['--tier', 'completo', '--json']);
    assert.equal(r.code, 0, r.stderr || r.stdout);
    const escopo = r.json?.results?.find((x) => x.gate === 'escopo');
    assert.ok(escopo, 'gate escopo ausente no JSON');
    assert.equal(escopo.status, 'warn');
    assert.equal(escopo.key, 'scope.empty');
    assert.equal(escopo.params.scope, 'worktree');
    assert.equal(r.json.status, 'pass');
  } finally { repo.cleanup(); }
});

test('run.mjs: tier rotina em árvore limpa também marca escopo vazio', () => {
  const repo = tempRepo();
  try {
    const r = runScript(repo, 'run.mjs', null, ['--tier', 'rotina', '--json']);
    assert.equal(r.code, 0, r.stderr || r.stdout);
    assert.equal(r.json?.results?.find((x) => x.gate === 'escopo')?.key, 'scope.empty');
  } finally { repo.cleanup(); }
});

test('run.mjs: tier rápido com escopo vazio NÃO ganha alerta (caminho por arquivo dos hooks)', () => {
  const repo = tempRepo();
  try {
    const r = runScript(repo, 'run.mjs', null, ['--tier', 'rapido', '--json']);
    assert.equal(r.code, 0, r.stderr || r.stdout);
    assert.ok(!r.json?.results?.some((x) => x.gate === 'escopo'));
  } finally { repo.cleanup(); }
});
