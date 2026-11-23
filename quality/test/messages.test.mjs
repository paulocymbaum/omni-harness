import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { catalog, t } from '../lib/messages.mjs';
import { QUALITY_DIR } from './helpers.mjs';

const PREFIXES = ['size', 'cc', 'fnloc', 'params', 'format', 'boundary', 'rule', 'suppress', 'fallback', 'exports', 'tool', 'lint', 'types',
  'build', 'tests', 'diffcov', 'cost', 'risk', 'summary', 'hook', 'action', 'report', 'error', 'evidence', 'agg'];

function sources() {
  const files = [];
  for (const dir of ['lib', 'lib/gates', 'hooks']) {
    for (const f of fs.readdirSync(path.join(QUALITY_DIR, dir))) if (f.endsWith('.mjs')) files.push(path.join(QUALITY_DIR, dir, f));
  }
  files.push(path.join(QUALITY_DIR, 'run.mjs'));
  return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
}

test('toda chave literal usada no código existe no catálogo pt-BR', () => {
  const code = sources();
  const re = new RegExp(`['\`]((?:${PREFIXES.join('|')})\\.[A-Za-z][\\w.-]*)['\`]`, 'g');
  const missing = [...new Set([...code.matchAll(re)].map((m) => m[1]))]
    .filter((k) => !k.includes('${') && typeof catalog[k] !== 'string');
  assert.deepEqual(missing, []);
});

test('chaves montadas dinamicamente existem', () => {
  for (const k of ['cc.warn', 'cc.warnLegacy', 'cc.failNew', 'cc.failGrew', 'fnloc.warn', 'fnloc.warnLegacy', 'fnloc.failNew', 'fnloc.failGrew',
    'risk.axis.breakage', 'risk.axis.cost', 'action.commit', 'action.push', 'action.deploy']) {
    assert.equal(typeof catalog[k], 'string', k);
  }
  for (const s of ['pass', 'fail', 'warn', 'skip']) assert.ok(catalog.status[s] && catalog.icon[s]);
  for (const l of ['baixo', 'medio', 'alto', 'critico']) assert.ok(catalog.level[l]);
  for (const tier of ['rapido', 'rotina', 'completo']) assert.ok(catalog.tier[tier]);
});

test('status em pt-BR, placeholders bem formados e números em formato brasileiro', () => {
  assert.deepEqual(catalog.status, { pass: 'APROVADO', fail: 'REPROVADO', warn: 'ALERTA', skip: 'IGNORADO' });
  for (const [k, v] of Object.entries(catalog)) {
    if (typeof v !== 'string') continue;
    assert.doesNotMatch(v.replace(/\{\w+\}/g, ''), /[{}]/, `placeholder malformado em ${k}`);
  }
  assert.match(t('size.fail', { file: 'a', value: 9340, previous: 9301, limit: 400, tolerance: 20 }), /9\.340/);
  assert.match(t('lint.issue', { file: 'a', line: 1234, code: 'x', msg: 'y' }), /a:1234 /);
  assert.throws(() => t('nao.existe'));
});
