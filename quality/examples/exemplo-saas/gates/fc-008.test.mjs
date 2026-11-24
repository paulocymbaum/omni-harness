// Gates FC-008 — secrets no Doppler (config creator) e esteira de deploy do worker com cache de camadas.
// ANTES da implementação cada gate DEVE falhar.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-11-14-fluxo-creator FC-008 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exists, read } from './fc-gate-helper.mjs';

const SPEC = 'docs/entregas/2026-11-14-fluxo-creator/specs/FC-008.md';
const WORKFLOW = '.github/workflows/creator-worker-deploy.yml';
const RUNBOOK = 'backend/deploy/secrets/creator-doppler.md';
const RENDER = 'render.yaml';

const noRealIds = (text, file) => {
  for (const email of text.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/g) ?? [])
    assert.ok(email.endsWith('@example.test'), `${file}: e-mail fora do domínio reservado`);
};

test('FC-008 workflow: buildx com cache gha publica o worker no ghcr com tag do sha e digest no summary', () => {
  assert.ok(exists(WORKFLOW), `workflow ausente: ${WORKFLOW}`);
  const wf = read(WORKFLOW);
  assert.match(wf, /docker\/build-push-action/, 'sem docker/build-push-action');
  assert.match(wf, /type=gha/, 'cache de camadas type=gha ausente (cache-from e cache-to)');
  assert.match(wf, /ghcr\.io/, 'push fora do ghcr.io');
  assert.match(wf, /github\.sha|sha-/, 'tag imutável do sha ausente');
  assert.match(wf, /digest/, 'digest não vai para o summary (amarração do render.yaml)');
  assert.match(wf, /services\/creator-worker/, 'paths não cobre o worker');
  assert.match(wf, /packages\/creator-render/, 'paths não cobre o alias do bundle (packages/creator-render)');
});

test('FC-008 runbook: config creator do Doppler com a lista fechada de chaves e nenhum valor real', () => {
  assert.ok(exists(RUNBOOK), `runbook ausente: ${RUNBOOK}`);
  const rb = read(RUNBOOK);
  for (const chave of [
    'Creator:LlmBaseUrl|Creator__LlmBaseUrl', 'Creator:LlmApiKey|Creator__LlmApiKey', 'Creator:LlmModel|Creator__LlmModel', 'Creator:AssetBucket|Creator__AssetBucket',
    'CREATOR_DATABASE_URL', 'CREATOR_LLM_BASE_URL', 'CREATOR_LLM_API_KEY', 'CREATOR_LLM_MODEL',
    'CREATOR_PULSO_DATA_DIR',
  ]) assert.ok(chave.split('|').some((forma) => rb.includes(forma)), `runbook sem a chave ${chave.split('|')[0]}`);
  assert.match(rb, /fluxo-creator-secrets/, 'runbook não aponta o grupo do render.yaml');
  assert.match(rb, /terraform/i, 'runbook sem o passo de aplicar o Terraform do FC-016');
  noRealIds(rb, RUNBOOK);
});

test('FC-008 docs: render.yaml continua prometendo o digest/Doppler e a spec alinha', () => {
  const render = read(RENDER);
  assert.match(render, /fluxo-creator-secrets/, 'render.yaml sem o grupo de secrets');
  assert.match(render, /FC-008/, 'render.yaml sem o ponteiro do FC-008');
  assert.match(read(SPEC), /Status: ready/, 'spec sem Status: ready');
  noRealIds(read(SPEC) + read(WORKFLOW), WORKFLOW);
});
