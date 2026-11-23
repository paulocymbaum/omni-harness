// Gates novos da trilha E: segredos (G1), optional chaining (G5), orçamento de jobs (G3) e
// actions pins (G8). Fixtures determinísticas; o orçamento usa raiz temporária com dirs injetados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { secretsGate, optionalChainingGate } from '../lib/gates/hygiene.mjs';
import { actionsPinsGate } from '../lib/gates/workflows.mjs';
import { costBudgetGate, schedulesTerraform, jobsManifesto } from '../lib/cost-job.mjs';
import { runsPerDay } from '../lib/risk.mjs';

const entrada = (path, linhas) => ({
  path, status: 'M',
  added: linhas.map((text) => ({ text })),
  removed: [],
  newText: linhas.join('\n'),
  oldText: '',
});

test('G1 segredos: chave de provedor no diff → fail', () => {
  const r = secretsGate(entrada('backend/src/x.cs', ['const k = "AKIAIOSFODNN7EXAMPLE";']));
  assert.equal(r[0].gate, 'segredos');
  assert.equal(r[0].status, 'fail');
  assert.equal(r[0].params.vendor, 'AWS');
});

test('G1 segredos: atribuição genérica longa → warn; placeholder e .md/test não alertam', () => {
  const warn = secretsGate(entrada('backend/src/x.cs', ['const token = "abcdef0123456789abcdef0123456789";']));
  assert.equal(warn[0].status, 'warn');
  assert.deepEqual(secretsGate(entrada('backend/src/x.cs', ['const token = "<valor do Doppler>";'])), []);
  assert.deepEqual(secretsGate(entrada('docs/nota.md', ['token = "abcdef0123456789abcdef0123456789"'])), []);
  assert.deepEqual(secretsGate(entrada('backend/test/x.test.cs', ['const token = "abcdef0123456789abcdef0123456789";'])), []);
});

test('G5 optional chaining: `?.` em scripts → fail; comentário e fora do escopo → nada', () => {
  const fail = optionalChainingGate(entrada('scripts/deploy/x.mjs', ['const v = obj?.campo;']));
  assert.equal(fail[0].gate, 'optional-chaining');
  assert.equal(fail[0].status, 'fail');
  assert.deepEqual(optionalChainingGate(entrada('scripts/deploy/x.mjs', ['// usa ?. quando presente'])), []);
  assert.deepEqual(optionalChainingGate(entrada('lib/app/x.dart', ['v = obj?.campo;'])), []);
});

test('G8 actions-pins: `uses:` sem SHA no diff → fail; pinado → nada', () => {
  const fail = actionsPinsGate([entrada('.github/workflows/x.yml', ['  - uses: actions/checkout@v4'])]);
  assert.equal(fail[0].gate, 'actions-pins');
  assert.equal(fail[0].status, 'fail');
  const ok = actionsPinsGate([entrada('.github/workflows/x.yml', ['  - uses: actions/checkout@8f4b7f84864484a7bf31766abe9204da3cbe65b3'])]);
  assert.deepEqual(ok, []);
  assert.deepEqual(actionsPinsGate([entrada('scripts/x.sh', ['uses: actions/checkout@v4'])]), []);
});

test('G3 orçamento: manifest + schedule TF correlacionados; acima do teto → fail', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qg3-'));
  try {
    fs.mkdirSync(path.join(base, 'backend/deploy/jobs'), { recursive: true });
    fs.mkdirSync(path.join(base, 'infra/gcp'), { recursive: true });
    fs.writeFileSync(path.join(base, 'backend/deploy/jobs/deploy.sh'), 'deploy_job fluxo-criador worker 512Mi 900s\n');
    fs.writeFileSync(path.join(base, 'infra/gcp/main.tf'), 'module "tick" {\n  name    = "fluxo-criador"\n  schedule = "*/5 * * * *"\n}\n');
    const out = [];
    costBudgetGate(base, out, { runsPerDay }, { dirs: ['backend/deploy', 'infra'] });
    assert.equal(out[0].status, 'fail');
    assert.ok(out[0].params.total > 400, JSON.stringify(out[0].params));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('G3 orçamento: job curto com tick raro fica bem abaixo do teto → pass', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qg3-'));
  try {
    fs.mkdirSync(path.join(base, 'backend/deploy/jobs'), { recursive: true });
    fs.writeFileSync(path.join(base, 'backend/deploy/jobs/deploy.sh'), 'deploy_job fluxo-limpeza worker 512Mi 60s\n');
    const out = [];
    costBudgetGate(base, out, { runsPerDay }, { dirs: ['backend/deploy'] });
    assert.equal(out[0].status, 'pass');
    assert.equal(out[0].params.jobs, 0, 'sem schedule correlacionado não há custo contável');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('schedulesTerraform: bloco module com name fluxo-* e schedule → intervalo em minutos', () => {
  const tf = 'module "tick" {\n  name     = "fluxo-criador"\n  schedule = "0 */2 * * *"\n}\n';
  assert.deepEqual([...schedulesTerraform(tf, runsPerDay)], [['fluxo-criador', 120]]);
});

test('jobsManifesto: tabela deploy_job → nome, memória e timeout', () => {
  const jobs = jobsManifesto('deploy_job fluxo-x worker 512Mi 15m\n');
  assert.equal(jobs.get('fluxo-x').timeoutMin, 15);
  assert.equal(jobs.get('fluxo-x').memoriaGi, 0.5);
});
