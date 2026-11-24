import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Run one exact, named Flutter test. A zero exit from `flutter test` is not
 * enough: Flutter can succeed after discovering no matching tests, so require
 * the exact test name and the one-test success summary as well.
 */
export function runFlutterCase(relativeFile, exactName) {
  const result = spawnSync('flutter', [
    'test',
    relativeFile,
    '--no-pub',
    '--name',
    `^${escapeRegExp(exactName)}$`,
    '--reporter',
    'expanded',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

  assert.equal(
    result.error,
    undefined,
    `flutter test não executou (${result.error?.message ?? 'erro desconhecido'}):\n${output}`,
  );
  assert.equal(result.status, 0, `flutter test falhou para "${exactName}":\n${output}`);
  assert.ok(
    output.includes(exactName),
    `caso Flutter exato "${exactName}" não foi descoberto/executado:\n${output}`,
  );
  assert.match(
    output,
    /\+\s*1:\s*All tests passed!/,
    `esperava exatamente um caso Flutter aprovado; pode estar ausente, pulado ou duplicado:\n${output}`,
  );
  assert.doesNotMatch(output, /~\s*\d+:/, `caso Flutter foi pulado:\n${output}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
