import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePorts, parseLsof } from '../../scripts/dev/liberar-portas.mjs';

test('parsePorts aceita porta única, várias e faixas, sem repetir', () => {
  assert.deepEqual(parsePorts(['8089']), [8089]);
  assert.deepEqual(parsePorts(['8089', '55432', '8089']), [8089, 55432]);
  assert.deepEqual(parsePorts(['8000-8002']), [8000, 8001, 8002]);
});

test('parsePorts rejeita entrada inválida', () => {
  for (const bad of [['80'], ['70000'], ['abc'], ['8010-8000'], ['1023'], []]) {
    assert.throws(() => parsePorts(bad), undefined, JSON.stringify(bad));
  }
  assert.throws(() => parsePorts(['2000-2100']), /mais de 50/);
});

test('parseLsof associa pid e comando', () => {
  assert.deepEqual(parseLsof('p123\ncjava\np456\ncnode\n'), [
    { pid: 123, command: 'java' },
    { pid: 456, command: 'node' },
  ]);
  assert.deepEqual(parseLsof(''), []);
});
