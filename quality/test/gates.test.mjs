import './bootstrap-example-profile.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sizeGate, boundaryGate, suppressionGate, fallbackGate, exportsGate, complexityGate, formatGate } from '../lib/gates/fast.mjs';
import { lizardCommand, which } from '../lib/tools.mjs';
import { entry, lines } from './helpers.mjs';

const statuses = (rs) => rs.map((r) => r.status);

// ------------------------------------------------------------ tamanho
test('tamanho: arquivo legado grande que não cresce passa (sem falso positivo)', () => {
  const big = lines(900);
  assert.deepEqual(statuses(sizeGate(entry('lib/features/map/presentation/map_page.dart', big, big.replace('v1 = 1', 'v1 = 2')))), ['pass']);
  assert.deepEqual(statuses(sizeGate(entry('lib/x.dart', big, lines(850)))), ['pass']);
});

test('tamanho: legado cresce pouco → ALERTA; cresce muito → REPROVADO', () => {
  assert.deepEqual(statuses(sizeGate(entry('lib/x.dart', lines(900), lines(910)))), ['warn']);
  assert.deepEqual(statuses(sizeGate(entry('lib/x.dart', lines(900), lines(960)))), ['fail']);
});

test('tamanho: arquivo novo acima de 400 + tolerância reprova; testes e não-código são ignorados', () => {
  assert.deepEqual(statuses(sizeGate(entry('functions/src/novo.ts', null, lines(500)))), ['fail']);
  assert.deepEqual(statuses(sizeGate(entry('functions/src/novo.ts', null, lines(410)))), ['warn']);
  assert.deepEqual(sizeGate(entry('test/features/feed/feed_test.dart', null, lines(2000))), []);
  assert.deepEqual(sizeGate(entry('docs/guia.md', null, lines(2000))), []);
  assert.deepEqual(sizeGate(entry('lib/l10n/app_localizations.dart', null, lines(5000))), []);
});

test('tamanho: linhas em branco não contam', () => {
  const padded = lines(390) + '\n'.repeat(300);
  assert.deepEqual(statuses(sizeGate(entry('lib/a.dart', null, padded))), ['pass']);
});

// ------------------------------------------------------------ fronteiras
const DOMAIN = 'lib/features/feed/domain/post.dart';

test('fronteiras: import proibido NOVO em domain reprova com linha correta', () => {
  const r = boundaryGate(entry(DOMAIN, "import 'post_id.dart';\n", "import 'post_id.dart';\nimport 'package:cloud_firestore/cloud_firestore.dart';\n"));
  assert.deepEqual(statuses(r), ['fail']);
  assert.equal(r[0].params.line, 2);
});

test('fronteiras: import proibido legado, reordenado ou movido não reprova (falso positivo)', () => {
  const old = "import 'package:cloud_firestore/cloud_firestore.dart';\nimport 'a.dart';\n";
  const reordered = "import 'a.dart';\nimport 'package:cloud_firestore/cloud_firestore.dart';\n\nclass X {}\n";
  assert.deepEqual(statuses(boundaryGate(entry(DOMAIN, old, reordered))), ['pass']);
  assert.deepEqual(statuses(boundaryGate(entry(DOMAIN, old, old + 'class Y {}\n'))), ['pass']);
});

test('fronteiras: foundation é permitido; material, data e presentation não', () => {
  assert.deepEqual(statuses(boundaryGate(entry(DOMAIN, null, "import 'package:flutter/foundation.dart';\n"))), ['pass']);
  assert.deepEqual(statuses(boundaryGate(entry(DOMAIN, null, "import 'package:flutter/material.dart';\n"))), ['fail']);
  assert.deepEqual(statuses(boundaryGate(entry(DOMAIN, null, "import '../data/feed_repository.dart';\n"))), ['fail']);
  assert.deepEqual(statuses(boundaryGate(entry(DOMAIN, null, "import 'package:fluxo/features/feed/presentation/feed_page.dart';\n"))), ['fail']);
});

test('fronteiras: pacote externo com "data" no caminho não é confundido com a camada data', () => {
  assert.deepEqual(statuses(boundaryGate(entry(DOMAIN, null, "import 'package:collection/data/queue.dart';\n"))), ['pass']);
});

test('fronteiras: data → presentation e shared → features', () => {
  assert.deepEqual(statuses(boundaryGate(entry('lib/features/feed/data/repo.dart', null, "import '../presentation/feed_cubit.dart';\n"))), ['fail']);
  assert.deepEqual(statuses(boundaryGate(entry('lib/shared/widgets/card.dart', null, "import 'package:fluxo/features/feed/domain/post.dart';\n"))), ['fail']);
  assert.deepEqual(statuses(boundaryGate(entry('lib/features/feed/presentation/page.dart', null, "import '../../events/presentation/event_page.dart';\n"))), []);
});

test('fronteiras: router do OCR e admin-web', () => {
  const r = 'OCR_webscraper_crawler/apps/router/src/routes/extract.ts';
  assert.deepEqual(statuses(boundaryGate(entry(r, "import { z } from 'zod';\n", "import { z } from 'zod';\nimport { scrape } from '@menu-extractor/scraper';\n"))), ['fail']);
  assert.deepEqual(statuses(boundaryGate(entry(r, null, "import { getConfig } from '@menu-extractor/shared';\n"))), ['pass']);
  assert.deepEqual(statuses(boundaryGate(entry('admin-web/src/api/reports.ts', null, "import { getFirestore } from 'firebase/firestore';\n"))), ['fail']);
  assert.deepEqual(statuses(boundaryGate(entry('admin-web/src/api/reports.ts', null, "import { getFunctions } from 'firebase/functions';\n"))), ['pass']);
  // Comentário mencionando o pacote não é import.
  assert.deepEqual(statuses(boundaryGate(entry(r, null, "// não importar @menu-extractor/scraper aqui\nexport const x = 1;\n"))), ['pass']);
});

// ------------------------------------------------------------ supressões, fallback, exports
test('supressões: conta só as novas (líquido)', () => {
  const old = "// ignore: avoid_print\nprint('a');\n";
  assert.deepEqual(statuses(suppressionGate(entry('lib/a.dart', old, old + "print('b');\n"))), ['pass']);
  assert.deepEqual(statuses(suppressionGate(entry('lib/a.dart', old, old + "// ignore: avoid_print\nprint('b');\n"))), ['warn']);
  assert.deepEqual(statuses(suppressionGate(entry('functions/src/a.ts', null, '// eslint-disable-next-line\nconst a: any = 1;\n'))), ['warn']);
});

test('fallback para Firestore: novo reprova, movido de lugar não (falso positivo)', () => {
  const f = 'lib/features/events/data/event_repository_impl.dart';
  const one = "void a() { log('create API fallback to Firestore'); }\n";
  assert.deepEqual(statuses(fallbackGate(entry(f, 'void b() {}\n', 'void b() {}\n' + one))), ['fail']);
  assert.deepEqual(statuses(fallbackGate(entry(f, one + 'void b() {}\n', 'void b() {}\n' + one))), ['pass']);
  assert.deepEqual(fallbackGate(entry('functions/src/a.ts', null, "// API fallback to Firestore\n")), []);
});

test('exports de functions/src/index.ts: remoção alerta; reordenação não', () => {
  const old = "export { a } from './a';\nexport * from './b';\nexport const c = 1;\n";
  assert.deepEqual(statuses(exportsGate(entry('functions/src/index.ts', old, "export const c = 1;\nexport * from './b';\nexport { a } from './a';\n"))), ['pass']);
  const r = exportsGate(entry('functions/src/index.ts', old, "export * from './b';\nexport const c = 1;\n"));
  assert.deepEqual(statuses(r), ['warn']);
  assert.match(r[0].params.names, /\ba\b/);
});

// ------------------------------------------------------------ complexidade (lizard)
const hasLizard = Boolean(lizardCommand());
const complexTs = (name, branches) => `export function ${name}(x: number) {\n${Array.from({ length: branches }, (_, i) => `  if (x === ${i}) return ${i};`).join('\n')}\n  return -1;\n}\n`;

test('complexidade: função nova acima do teto reprova; legada intocada não', { skip: !hasLizard && 'lizard ausente' }, () => {
  const legacy = complexTs('legada', 30);
  const f = 'functions/src/features/x.ts';
  assert.deepEqual(statuses(complexityGate(entry(f, legacy, legacy + '\nexport const y = 1;\n'))).filter((s) => s !== 'pass'), []);
  const r = complexityGate(entry(f, legacy, legacy + complexTs('nova', 25)));
  assert.ok(r.some((x) => x.status === 'fail' && x.params.function === 'nova'));
});

test('complexidade: legada que cresce dentro da tolerância → ALERTA; além → REPROVADO', { skip: !hasLizard && 'lizard ausente' }, () => {
  const f = 'functions/src/features/x.ts';
  const warn = complexityGate(entry(f, complexTs('legada', 30), complexTs('legada', 31)));
  assert.ok(warn.some((x) => x.gate === 'complexidade' && x.status === 'warn'));
  const fail = complexityGate(entry(f, complexTs('legada', 30), complexTs('legada', 36)));
  assert.ok(fail.some((x) => x.gate === 'complexidade' && x.status === 'fail'));
});

test('complexidade: função simples nova passa e testes são ignorados', { skip: !hasLizard && 'lizard ausente' }, () => {
  assert.deepEqual(statuses(complexityGate(entry('functions/src/a.ts', null, complexTs('simples', 3)))), ['pass']);
  assert.deepEqual(complexityGate(entry('functions/test/a.test.ts', null, complexTs('grande', 40))), []);
});

// ------------------------------------------------------------ formatação Dart
test('formato: não formatado no HEAD e continua → sem falso positivo; formatado que piora → REPROVADO', { skip: !which('dart') && 'dart ausente' }, () => {
  const ok = 'void main() {\n  print(1);\n}\n';
  const bad = 'void main( ){print( 1 );}\n';
  assert.deepEqual(statuses(formatGate(entry('lib/a.dart', bad, bad + 'void b( ){}\n'))), ['pass']);
  assert.deepEqual(statuses(formatGate(entry('lib/a.dart', ok, bad))), ['fail']);
  assert.deepEqual(statuses(formatGate(entry('lib/a.dart', ok, ok))), ['pass']);
  assert.deepEqual(statuses(formatGate(entry('lib/a.dart', ok, 'void main( {'))), ['warn']);
});

test('supressões: marcador citado em comentário/strings não conta; diretiva real conta uma vez', () => {
  const doc = '// Este gate detecta eslint-disable e @ts-ignore em comentários.\nconst x = "// eslint-disable";\n';
  assert.deepEqual(statuses(suppressionGate(entry('functions/src/a.ts', null, doc))), ['pass']);
  const r = suppressionGate(entry('lib/a.dart', null, '// ignore_for_file: avoid_print\nvoid main() {}\n'));
  assert.equal(r[0].params.value, 1);
});
