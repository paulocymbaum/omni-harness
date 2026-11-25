// --relatorio em hosts sem camadas no perfil (ex.: o próprio harness): fallback de camada única
// em vez de relatório vazio (0 seções, score —). Rode: node --test quality/test/relatorio.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selecionarCamadas } from '../lib/relatorio.mjs';
import { tempRepo, runScript } from './helpers.mjs';

const L = (id, globs) => ({ id, nome: id, stack: '—', globs });

test('selecionarCamadas: perfil sem camadas → camada única de fallback', () => {
  const sel = selecionarCamadas(['a.mjs', 'b.ts'], [], null);
  assert.deepEqual(sel.map((l) => l.id), ['repo']);
});

test('selecionarCamadas: camadas definidas, nenhuma casa na árvore → camada única', () => {
  const sel = selecionarCamadas(['quality/run.mjs', 'docs/x.md'], [L('flutter', ['lib/**/*.dart']), L('backend', ['backend/**'])], null);
  assert.deepEqual(sel.map((l) => l.id), ['repo']);
});

test('selecionarCamadas: camada com arquivo na árvore → sem fallback', () => {
  const sel = selecionarCamadas(['quality/run.mjs'], [L('quality', ['quality/**'])], null);
  assert.deepEqual(sel.map((l) => l.id), ['quality']);
});

test('selecionarCamadas: perfil com ao menos uma camada com arquivo mantém TODAS as camadas (docs fora)', () => {
  const sel = selecionarCamadas(['functions/src/a.ts'], [L('functions', ['functions/**']), L('backend', ['**/*.ts']), L('docs', ['docs/**'])], null);
  const ids = sel.map((l) => l.id);
  assert.ok(ids.includes('functions') && ids.includes('backend'), ids.join(','));
  assert.ok(!ids.includes('docs'));
  assert.ok(!ids.includes('repo'));
});

test('selecionarCamadas: --camadas explícito nunca cai no fallback (seções vazias honestas)', () => {
  const sel = selecionarCamadas(['quality/run.mjs'], [L('flutter', ['lib/**/*.dart'])], ['flutter']);
  assert.deepEqual(sel.map((l) => l.id), ['flutter']);
});

test('run.mjs: --relatorio em repo sem perfil de camadas gera UMA seção, não zero', () => {
  const repo = tempRepo({ 'src/app.mjs': 'export const a = 1;\n' });
  try {
    const r = runScript(repo, 'run.mjs', null, ['--relatorio', '--json']);
    assert.equal(r.code, 0, r.stderr || r.stdout);
    assert.equal(r.json?.sections?.length, 1, JSON.stringify(r.json?.sections?.map((s) => s.layer?.id)));
    assert.equal(r.json.sections[0].layer.id, 'repo');
    assert.equal(r.json.sections[0].m.src, 1);
  } finally { repo.cleanup(); }
});
