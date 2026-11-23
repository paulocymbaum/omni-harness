// Gates FC-016 — bucket de assets do Creator (GCS, IAM, CORS, lifecycle de staging/).
// ANTES da implementação cada gate DEVE falhar.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-11-14-fluxo-creator FC-016 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exists, read } from './fc-gate-helper.mjs';

const SPEC = 'docs/entregas/2026-11-14-fluxo-creator/specs/FC-016.md';
const TF = 'infra/gcp/terraform/environments/prod/creator.tf';
const VARS = 'infra/gcp/terraform/environments/prod/variables.tf';
const LOCAL_README = 'backend/deploy/creator-local/README.md';

const noRealIds = (text, file) => {
  for (const email of text.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/g) ?? [])
    assert.ok(email.endsWith('@example.test'), `${file}: e-mail fora do domínio reservado`);
};

test('FC-016 terraform: bucket privado com CORS do signer, lifecycle de staging/ e IAM da API', () => {
  assert.ok(exists(TF), `arquivo ausente: ${TF}`);
  const tf = read(TF);
  assert.match(tf, /resource\s+"google_storage_bucket"/, 'bucket ausente');
  assert.match(tf, /uniform_bucket_level_access\s*=\s*true/, 'uniform bucket level access obrigatório');
  assert.match(tf, /public_access_prevention\s*=\s*"enforced"/, 'public access prevention enforced');
  // CORS para o PUT direto: origem de produção + dev e o header que o signer V4 usa.
  assert.match(tf, /cors\s*\{/, 'bloco cors ausente');
  assert.match(tf, /x-goog-content-length-range/, 'CORS sem o header do signer V4');
  assert.match(tf, /http:\/\/localhost:5173/, 'CORS sem origem de dev (5173)');
  assert.match(tf, /method\s*=\s*\[?\s*"PUT"/, 'CORS sem PUT');
  // Ciclo de vida: staging/ expira (rascunho/inputs), assets prontos ficam — blocos em qualquer ordem.
  const rules = tf.match(/lifecycle_rule\s*\{[\s\S]*?\n  \}/g) ?? [];
  assert.ok(
    rules.some((rule) => rule.includes('staging/') && /type\s*=\s*"Delete"/.test(rule)),
    'lifecycle de staging/ ausente',
  );
  assert.match(tf, /google_storage_bucket_iam_member/, 'IAM do bucket ausente');
  assert.match(tf, /roles\/storage\.objectAdmin/, 'papel objectAdmin ausente');
  const vars = read(VARS);
  for (const variavel of ['creator_bucket_name', 'creator_staging_ttl_days'])
    assert.match(vars, new RegExp(`variable\\s+"${variavel}"`), `variável ausente: ${variavel}`);
  noRealIds(tf, TF);
});

test('FC-016 docs: README local aponta o FC-016 e a spec registra o storage pronto', () => {
  assert.ok(exists(SPEC), `spec ausente: ${SPEC}`);
  const spec = read(SPEC);
  assert.match(spec, /Status: ready/, 'spec sem Status: ready');
  assert.match(spec, /creator_storage_unavailable/, 'spec não cita o 503 quando AssetBucket vazio');
  const readme = read(LOCAL_README);
  assert.match(readme, /FC-016[\s\S]{0,400}terraform apply/i, 'README local sem a nota do FC-016 com o passo de aplicar o Terraform');
  noRealIds(readme, LOCAL_README);
});
