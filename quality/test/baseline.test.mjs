// Gate QG-002 — baseline global do ratchet (quality/baseline.mjs).
// Testa os helpers puros: contagem de supressões (com strings sanitizadas),
// violações de fronteira por regra e a lógica de comparação do ratchet.
// Rode: node --test quality/test/baseline.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { countSuppressions, countBoundaryViolations, compare, flutterFeaturesWithoutTest } from '../baseline.mjs';

test('qg-002: supressão real de lint conta; marcador dentro de string não conta', () => {
  const dart = [
    'void f() {',
    '  // ignore: avoid_print',
    '  print("exemplo com // ignore: falso dentro de string");',
    '}',
  ].join('\n');
  const perKind = countSuppressions(dart, 'dart');
  assert.equal(perKind['// ignore:'], 1);

  const ts = '// eslint-disable-next-line no-console\n// @ts-ignore\nconst a = 1;\n';
  const tsKinds = countSuppressions(ts, 'typescript');
  assert.equal(tsKinds['eslint-disable'], 1);
  assert.equal(tsKinds['@ts-ignore'], 1);

  assert.equal(countSuppressions('# x = 1  # noqa\n', 'python')['# noqa'], 1);
  assert.equal(
    countSuppressions('#pragma warning disable CS1591\n', 'csharp')['#pragma warning disable'],
    1,
  );
});

test('qg-002: fronteiras — domain importando cloud_firestore viola; foundation é permitido', () => {
  const domain = [
    "import 'package:cloud_firestore/cloud_firestore.dart';",
    "import 'package:flutter/foundation.dart';",
    "import 'package:fluxo/features/feed/data/post_repository.dart';",
  ].join('\n');
  const perRule = countBoundaryViolations('lib/features/feed/domain/post.dart', domain);
  assert.equal(perRule['rule.domainInfra'], 2); // firestore + data/ (foundation é permitido)

  const data = "import 'package:fluxo/features/feed/presentation/post_page.dart';\n";
  assert.equal(
    countBoundaryViolations('lib/features/feed/data/post_repository.dart', data)['rule.dataPresentation'],
    1,
  );

  // arquivo fora do alcance das regras: nada
  assert.deepEqual(countBoundaryViolations('lib/features/feed/presentation/x.dart', domain), {});
});

test('qg-002: ratchet — piora reprova, melhoria vira ganho, report-only é ignorado', () => {
  const before = {
    layers: { flutter: { sourceFiles: 900, maxNloc: 9301, filesOverNloc: 92, suppressions: 21 } },
    repo: {
      apiFallbacks: 23,
      functionsExports: 180,
      cc: { maxCc: 40 },
    },
  };
  const piora = {
    layers: { flutter: { sourceFiles: 905, maxNloc: 9400, filesOverNloc: 92, suppressions: 21 } },
    repo: { apiFallbacks: 24, functionsExports: 190, cc: { maxCc: 40 } },
  };
  const r1 = compare(before, piora);
  assert.ok(r1.regressions.some((r) => r.metric === 'layers.flutter.maxNloc' && r.after === 9400));
  assert.ok(r1.regressions.some((r) => r.metric === 'repo.apiFallbacks'));
  // sourceFiles e functionsExports são report-only: crescimento não reprova
  assert.ok(!r1.regressions.some((r) => r.metric.includes('sourceFiles')));
  assert.ok(!r1.regressions.some((r) => r.metric.includes('functionsExports')));

  const melhora = {
    layers: { flutter: { sourceFiles: 900, maxNloc: 9301, filesOverNloc: 90, suppressions: 20 } },
    repo: { apiFallbacks: 21, functionsExports: 180, cc: { maxCc: 40 } },
  };
  const r2 = compare(before, melhora);
  assert.equal(r2.regressions.length, 0);
  assert.ok(r2.improvements.some((i) => i.metric === 'repo.apiFallbacks' && i.after === 21));
});

test('qg-002: métrica sem valor no baseline (ex.: lizard ausente na gravação) vira skipped, não reprovada', () => {
  const before = { layers: { flutter: { maxNloc: null } } };
  const after = { layers: { flutter: { maxNloc: 120 } } };
  const r = compare(before, after);
  assert.equal(r.regressions.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].metric, 'layers.flutter.maxNloc');
});


test('qg-002: features Flutter sem teste detectadas por diretório em test/features', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qg002-'));
  try {
    fs.mkdirSync(path.join(tmp, 'lib/features/feed'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'lib/features/messages'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'test/features/feed'), { recursive: true });
    const res = flutterFeaturesWithoutTest(tmp);
    assert.equal(res.count, 1);
    assert.deepEqual(res.list, ['messages']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
