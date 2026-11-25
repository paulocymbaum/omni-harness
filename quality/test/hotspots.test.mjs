// Hotspots P5: prova determinística de que as funções alvo ficaram dentro do teto (CCN) e da
// meta (NLOC) — RED no refactor, GREEN depois; trava para nunca regressar. Sem lizard, pula
// (nunca aprova com base parcial). Rode: node --test quality/test/hotspots.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lizardOnFiles, lizardCommand } from '../lib/tools.mjs';
import { repoRoot } from '../lib/util.mjs';

const ALVOS = [
  { file: 'quality/lib/profile.mjs', funcao: 'validateProfile', ccnMax: 20 },
  { file: 'quality/baseline.mjs', funcao: 'measure', ccnMax: 20 },
  { file: 'quality/lib/runners/flutter.mjs', funcao: 'flutterFronteiras', ccnMax: 20 },
  { file: 'quality/lib/runners/flutter.mjs', funcao: 'flutterFeaturesSemTestes', ccnMax: 20 },
  { file: 'quality/lib/gates/fast.mjs', funcao: 'julgaParHalstead', nlocMax: 120 },
  { file: 'scripts/tracker/sync-context.mjs', funcao: 'markdownToAdf', ccnMax: 20, nlocMax: 60 },
  { file: 'scripts/tracker/jira-client.mjs', funcao: 'createClient', nlocMax: 60 },
];

test('hotspots do P5 ficam abaixo do teto (CCN) e da meta (NLOC)', { skip: !lizardCommand() && 'lizard ausente' }, () => {
  const root = repoRoot();
  const medidas = new Map();
  for (const { file } of ALVOS) {
    if (!medidas.has(file)) medidas.set(file, lizardOnFiles(root, [file], () => 'javascript') ?? []);
  }
  const problemas = [];
  for (const alvo of ALVOS) {
    const fns = (medidas.get(alvo.file) || []).filter((f) => f.name === alvo.funcao);
    if (!fns.length) { problemas.push(`${alvo.funcao}: não medida em ${alvo.file}`); continue; }
    const f = fns[0];
    if (alvo.ccnMax && f.ccn > alvo.ccnMax) problemas.push(`${alvo.funcao}: CCN ${f.ccn} > ${alvo.ccnMax} (${f.file}:${f.start})`);
    if (alvo.nlocMax && f.nloc > alvo.nlocMax) problemas.push(`${alvo.funcao}: ${f.nloc} linhas > ${alvo.nlocMax} (${f.file}:${f.start})`);
  }
  assert.deepEqual(problemas, []);
});
