// Gate P0 (performance): batchFastGates tem os MESMOS vereditos do caminho por-entry
// (fastGates), só com spawns agregados — lizard 4/chunk + dart format 1/chunk em vez de
// 8-10 por arquivo (docs/parking-lot/performance-camadas.md, D1). Skips condicionais com
// motivo quando o hospedeiro não tem a toolchain (padrão anti-force-pass).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { batchFastGates, fastGates } from '../lib/gates/fast.mjs';
import { lizardCommand, which } from '../lib/tools.mjs';
import { repoRoot } from '../lib/util.mjs';

const TEM_DART = Boolean(which('dart'));
const TEM_LIZARD = Boolean(lizardCommand());
const SEM = (oque) => `${oque} ausente neste hospedeiro — equivalência coberta pelos parsers unitários`;

const mk = (path, newText, oldText = null) => ({ path, status: 'M', newText, oldText, added: [] });
const assinatura = (rs) => rs.map((r) => `${r.gate}|${r.status}|${r.key}|${r.file}`).sort();

const dartFormatado = 'class Soma {\n  int m(int a) {\n    var t = 0;\n    for (var i = 0; i < a; i++) {\n      t += i;\n    }\n    return t;\n  }\n}\n';
const dartComplexo = 'class Densa {\n  int m(int a) {\n    var t = 0;\n    for (var i = 0; i < a; i++) {\n      if (i % 3 == 0) {\n        t += i * 2;\n      } else if (i % 3 == 1) {\n        t -= i;\n      } else {\n        while (t > 100) {\n          t -= 7;\n        }\n      }\n    }\n    return t;\n  }\n}\n';
const tsFonte = 'export function soma(a: number, b: number): number {\n  return a + b;\n}\n';

test('batchFastGates == fastGates: mesmos vereditos por arquivo (dart/ts/md)', { skip: !TEM_LIZARD || !TEM_DART ? SEM('lizard/dart') : false }, () => {
  const entries = [
    mk('lib/ok.dart', dartFormatado),
    mk('src/app.ts', tsFonte),
    mk('docs/nota.md', '# nota\n'),
  ];
  assert.deepEqual(assinatura(batchFastGates(entries)), assinatura(entries.flatMap((e) => fastGates(e))));
});

test('batchFastGates == fastGates com ratchet: suspeito de complexidade mede o oldText', { skip: !TEM_LIZARD || !TEM_DART ? SEM('lizard/dart') : false }, () => {
  const entries = [mk('lib/densa.dart', dartComplexo, dartFormatado)];
  const individual = entries.flatMap((e) => fastGates(e));
  const lote = batchFastGates(entries);
  const status = (rs) => assinatura(rs).filter((s) => !s.endsWith('|pass'));
  assert.deepEqual(status(lote), status(individual), 'vereditos não-pass idênticos (ratchet exato no lote)');
});

test('formatGatesBatch usa o disco quando igual ao diff (1 spawn para o chunk)', { skip: !TEM_DART ? SEM('dart') : false }, () => {
  const probeRel = path.join('quality', 'tmp-probe-formato.dart');
  const abs = path.join(repoRoot(), probeRel);
  fs.writeFileSync(abs, dartFormatado);
  try {
    const lote = batchFastGates([mk(probeRel, dartFormatado)]);
    assert.deepEqual(assinatura(lote).filter((s) => s.startsWith('formato')), ['formato|pass|format.pass|' + probeRel]);
  } finally {
    fs.rmSync(abs, { force: true });
  }
});

test('batchFastGates: arquivo fora da stack não gera resultado nenhum', () => {
  assert.deepEqual(batchFastGates([mk('docs/nota.md', '# x\n')]), []);
});
