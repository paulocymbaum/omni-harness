// Gates das categorias (labels) com slug da feature nos cards de Jira.
// Garante que todo card criado/atualizado pelos harnesses recebe
// `feature-<slug>` + categorias extras, sanitizadas ao alfabeto do Jira.
// Rodar: node --test quality/test/jira-labels.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  sanitizeJiraLabel, featureSlugFromDir, resolveFeatureSlug, cardLabels,
} from '../../quality/delivery/lib.mjs';
import { labelsAddPatch } from '../../scripts/tracker/jira-client.mjs';
import { cardSummary, existingIssueJqls, parseSyncFlags } from '../../scripts/tracker/sync-context.mjs';

const BACKLOG_MJS = path.resolve(import.meta.dirname, '..', 'delivery', 'backlog.mjs');

function runBacklog(args) {
  const r = spawnSync(process.execPath, [BACKLOG_MJS, ...args], {
    encoding: 'utf8', timeout: 30_000, env: { ...process.env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function tmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eg-jira-labels-')));
}

test('sanitizeJiraLabel: acentos, espaços e símbolos viram alfabeto Jira', () => {
  assert.equal(sanitizeJiraLabel('São Paulo'), 'sao-paulo');
  assert.equal(sanitizeJiraLabel('Exemplo SaaS Ônibus (MVP!)'), 'exemplo-saas-onibus-mvp');
  assert.equal(sanitizeJiraLabel('  --x--  '), 'x');
  assert.equal(sanitizeJiraLabel(''), null);
  assert.equal(sanitizeJiraLabel(null), null);
  assert.ok(sanitizeJiraLabel('a'.repeat(300)).length <= 255, 'respeita limite da API');
});

test('featureSlugFromDir: remove prefixo de data do diretório da entrega', () => {
  assert.equal(featureSlugFromDir('/tmp/2026-10-27-fluxo-onibus-pesquisa-apis'), 'fluxo-onibus-pesquisa-apis');
  assert.equal(featureSlugFromDir('/tmp/harness'), 'harness');
  assert.equal(featureSlugFromDir('/tmp/2026-10-27 Exemplo SaaS Ônibus'), '2026-10-27-exemplo-saas-onibus');
  assert.equal(featureSlugFromDir(null), null);
});

test('resolveFeatureSlug: featureSlug explícito vence o derivado do diretório', () => {
  assert.equal(resolveFeatureSlug({ featureSlug: 'Exemplo SaaS Ônibus' }, '/x/2026-01-01-outra'), 'exemplo-saas-onibus');
  assert.equal(resolveFeatureSlug({}, '/x/2026-01-01-outra'), 'outra');
  assert.equal(resolveFeatureSlug(null, '/x/2026-01-01-outra'), 'outra');
});

test('cardLabels: feature-<slug> sempre presente, categorias mescladas e dedup', () => {
  const labels = cardLabels(
    { featureSlug: 'Exemplo SaaS Ônibus', categories: ['Parking Lot'] },
    '/x/2026-01-01-outra',
  );
  assert.deepEqual(labels, ['feature-exemplo-saas-onibus', 'parking-lot']);

  const override = cardLabels(null, null, { featureSlug: 'cnpj-alfanumerico', categories: ['2026'] });
  assert.deepEqual(override, ['feature-cnpj-alfanumerico', '2026']);

  const dedup = cardLabels(null, null, { categories: ['harness', 'Harness', 'feature-harness'] });
  assert.deepEqual(dedup, ['harness', 'feature-harness']);

  assert.deepEqual(cardLabels(), []);
});

test('cardLabels: versao-<tag> com default no created do backlog e override', () => {
  const comData = cardLabels({ featureSlug: 'fluxo-onibus', created: '2026-10-27' }, null);
  assert.deepEqual(comData, ['feature-fluxo-onibus', 'versao-2026-10-27']);

  const doBacklog = cardLabels({ featureSlug: 'x', created: '2026-10-27', version: 'v2.0' }, null);
  assert.deepEqual(doBacklog, ['feature-x', 'versao-v2.0']);

  const comFlag = cardLabels({ featureSlug: 'x', version: 'v2.0' }, null, { version: 'v3.0' });
  assert.deepEqual(comFlag, ['feature-x', 'versao-v3.0']);
});

test('cardSummary: nome limpo — sem feature, sem data', () => {
  const s = cardSummary({ id: 'RB-001', title: 'Documentação final e entrega piloto' });
  assert.equal(s, 'RB-001 — Documentação final e entrega piloto');
  assert.ok(!s.includes('['), 'sem tag de feature/backlog no nome');
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(s), 'sem data no nome (created é campo do card)');
});

test('existingIssueJqls: label da feature primeiro, legado por último', () => {
  const jqls = existingIssueJqls('OFLUXO', {
    task: { id: 'RB-001' }, backlogId: '2026-10-01-harness', featureSlug: 'harness',
  });
  assert.equal(jqls.length, 2);
  assert.match(jqls[0], /labels = "feature-harness"/);
  assert.match(jqls[0], /summary ~ "RB-001"/);
  assert.match(jqls[1], /summary ~ "2026-10-01-harness"/);

  const semFeature = existingIssueJqls('OFLUXO', { task: { id: 'T-1' }, backlogId: 'b', featureSlug: null });
  assert.equal(semFeature.length, 1);
  assert.match(semFeature[0], /summary ~ "b"/);
});

test('labelsAddPatch: patch aditivo para a API v3; vazio não gera chamada', () => {
  assert.deepEqual(labelsAddPatch(['feature-x', 'y']), {
    update: { labels: [{ add: 'feature-x' }, { add: 'y' }] },
  });
  assert.equal(labelsAddPatch([]), null);
  assert.equal(labelsAddPatch(null), null);
});

test('parseSyncFlags: --status/--feature/--versao únicas, --categoria repetível', () => {
  const parsed = parseSyncFlags(['--status', 'Done', '--feature', 'fluxo-onibus', '--versao', 'v2.0', '--categoria', 'a', '--categoria', 'b']);
  assert.equal(parsed.statusOverride, 'Done');
  assert.equal(parsed.featureSlug, 'fluxo-onibus');
  assert.equal(parsed.versao, 'v2.0');
  assert.deepEqual(parsed.categories, ['a', 'b']);
});

test('parseSyncFlags: sem --status, flag alheia não vira status (regressão)', () => {
  const parsed = parseSyncFlags(['--feature', 'x']);
  assert.equal(parsed.statusOverride, null);
  assert.equal(parsed.featureSlug, 'x');
});

test('backlog init: grava featureSlug e categories sanitizados; status exibe', () => {
  const dir = tmpDir();
  const r = runBacklog(['init', dir, '--feature', 'Exemplo SaaS Ônibus', '--versao', 'V1.0', '--categoria', 'Parking Lot', '--categoria', 'mobilidade']);
  assert.equal(r.code, 0, r.stderr);
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'backlog.json'), 'utf8'));
  assert.equal(data.featureSlug, 'exemplo-saas-onibus');
  assert.equal(data.version, 'v1.0');
  assert.deepEqual(data.categories, ['parking-lot', 'mobilidade']);

  const s = runBacklog(['status', dir]);
  assert.equal(s.code, 0, s.stderr);
  assert.ok(s.stdout.includes('Feature: exemplo-saas-onibus'));
  assert.ok(s.stdout.includes('Versão: v1.0'));
  assert.ok(s.stdout.includes('Categorias: parking-lot, mobilidade'));
  fs.rmSync(dir, { recursive: true, force: true });
});
