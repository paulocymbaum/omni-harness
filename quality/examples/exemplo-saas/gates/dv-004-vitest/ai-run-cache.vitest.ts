import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { harness, ids, input, providerError, response, vertexOptions } from './support';
import { EXTRACT_PROMPT_VERSION } from '../../src/extract/prompt';

it('fábrica usa AnthropicVertex com projeto e região sem chave Anthropic', async () => {
  const { createVertexClient } = await import('../../src/ai/vertex-claude');
  vertexOptions().length = 0;
  const client = createVertexClient({ VERTEX_PROJECT_ID: 'fluxo-offline', VERTEX_REGION: 'global',
    ANTHROPIC_API_KEY: 'fixture-key-not-real' });
  expect(client.messages).toBeDefined();
  expect(vertexOptions()).toHaveLength(1);
  expect(vertexOptions()[0]).toMatchObject({ projectId: 'fluxo-offline', region: 'global' });
  expect(vertexOptions()[0]).not.toHaveProperty('apiKey');
  expect(JSON.stringify(vertexOptions())).not.toContain('fixture-key-not-real');
  createVertexClient({ VERTEX_PROJECT_ID: 'fluxo-offline' });
  expect(vertexOptions()[1].region).toBe('global');
});

it('requisição usa modelo configurado, JSON Schema e cache no último bloco', async () => {
  const h = harness();
  await h.extractor.extract(input());
  const req = h.requests[0];
  expect(req.model).toBe('claude-haiku-5-5');
  expect(req.max_tokens).toBe(2048);
  expect(req.output_config.format.type).toBe('json_schema');
  expect(req.output_config.format.schema.properties.claims).toBeDefined();
  expect(req.output_config.effort).toBe('low');
  expect(req).not.toHaveProperty('output_format');
  expect(req).not.toHaveProperty('tool_choice');
  expect(req.system).toHaveLength(2);
  expect(req.system[0].type).toBe('text');
  expect(req.system[0].text.length / 8).toBeGreaterThan(512);
  expect(req.system[0]).not.toHaveProperty('cache_control');
  expect(req.system[1].cache_control).toEqual({ type: 'ephemeral' });
  expect(req.messages).toHaveLength(1);
  expect(req.messages[0].role).toBe('user');

  vi.stubEnv('EXTRACTION_MODEL', 'fixture-model-from-env');
  try {
    const fromEnv = harness([response()], { model: undefined });
    await fromEnv.extractor.extract(input());
    expect(fromEnv.requests[0].model).toBe('fixture-model-from-env');
  } finally { vi.unstubAllEnvs(); }
});

it('prefixo e versão são idênticos entre candidatos e hash corresponde ao texto', async () => {
  const h = harness([response(), response()]);
  await h.extractor.extract(input());
  await h.extractor.extract(input(undefined, ids.other));
  expect(h.requests[0].system).toEqual(h.requests[1].system);
  const suffix = createHash('sha256').update(h.requests[0].system[0].text).digest('hex').slice(0, 12);
  expect(EXTRACT_PROMPT_VERSION).toMatch(new RegExp(`^extract-v\\d+-${suffix}$`));
  expect(h.runs().map((w) => w.body.promptVersion)).toEqual([EXTRACT_PROMPT_VERSION, EXTRACT_PROMPT_VERSION]);
  expect(h.extractions().map((w) => w.body.promptVersion)).toEqual([EXTRACT_PROMPT_VERSION, EXTRACT_PROMPT_VERSION]);
});

it('envia só as seis últimas falas, pergunta aberta e fala-alvo no contexto variável', async () => {
  const arg = input();
  arg.item.context = Array.from({ length: 8 }, (_, i) => ({
    utteranceId: `context-${i}`, participantId: ids.other, speakerLabel: '1:1',
    text: `FALA_ANTERIOR_UNICA_${i}`, startSec: i,
  }));
  const h = harness();
  await h.extractor.extract(arg);
  const system = JSON.stringify(h.requests[0].system);
  const variable = JSON.stringify(h.requests[0].messages[0].content);
  expect(variable).not.toContain('FALA_ANTERIOR_UNICA_0');
  expect(variable).not.toContain('FALA_ANTERIOR_UNICA_1');
  for (let i = 2; i < 8; i++) expect(variable).toContain(`FALA_ANTERIOR_UNICA_${i}`);
  for (const text of [ids.item, arg.item.utterance.text, ids.question, arg.item.openQuestions[0].text,
    arg.item.block.title, ids.candidate]) expect(variable).toContain(text);
  expect(system).not.toContain(arg.item.utterance.text);
  for (const p of arg.debate.participants) {
    expect(system).toContain(p.id); expect(system).toContain(p.ballotName);
  }
});

it('ai-run antecede extração, preserva tokens de cache e hash do corpo', async () => {
  const h = harness();
  await h.extractor.extract(input());
  expect(h.events).toEqual(['model', 'ai-run', 'extraction']);
  expect(h.runs()).toHaveLength(1);
  const run = h.runs()[0];
  expect(run.route).toBe(`/api/v1/internal/debates/${ids.debate}/ai-runs`);
  expect(run.key).toBe(`airun:${ids.lease}:${ids.item}:1`);
  expect(run.body).toMatchObject({ kind: 'extraction', provider: 'vertex-anthropic',
    model: 'claude-haiku-5-5', region: 'global', promptVersion: EXTRACT_PROMPT_VERSION,
    inputTokens: 120, outputTokens: 45, cacheCreationInputTokens: 80, cacheReadInputTokens: 64,
    invalidItems: 0, status: 'ok', subjectType: 'utterance', subjectId: ids.item,
    inputSha256: createHash('sha256').update(JSON.stringify(h.requests[0])).digest('hex') });
  expect(Number.isFinite(run.body.latencyMs)).toBe(true);
  expect(run.body.latencyMs).toBeGreaterThanOrEqual(0);
  expect(run.body).not.toHaveProperty('costUsd');
  expect(run.body).not.toHaveProperty('estimatedCostUsd');
  expect(h.extractions()[0].body.aiRunId).toBe('adadadad-adad-4ada-8ada-adadadadada1');
});

it('Haiku 4.5 omite effort', async () => {
  const h = harness([response()], { model: 'claude-haiku-4-5@20251001' });
  await h.extractor.extract(input());
  expect(h.requests[0].model).toBe('claude-haiku-4-5@20251001');
  expect(h.requests[0].output_config).not.toHaveProperty('effort');
});

it('408, 429 e 503 têm retry limitado com backoff e auditoria por chamada', async () => {
  for (const status of [408, 429, 503]) {
    const h = harness([providerError(status), providerError(status), response()]);
    expect((await h.extractor.extract(input())).status).toBe('ok');
    expect(h.requests).toHaveLength(3);
    expect(h.runs().map((w) => w.body.status)).toEqual(['error', 'error', 'ok']);
    expect(h.runs().map((w) => w.key)).toEqual([1, 2, 3].map((n) => `airun:${ids.lease}:${ids.item}:${n}`));
    expect(h.events).toEqual(['model', 'ai-run', 'model', 'ai-run', 'model', 'ai-run', 'extraction']);
    expect(h.delays).toHaveLength(2);
    expect(h.delays[0]).toBeGreaterThan(0);
    expect(h.delays[1]).toBeGreaterThan(h.delays[0]);
    for (const run of h.runs().slice(0, 2)) expect(run.body.errorType).toEqual(expect.any(String));

    const exhausted = harness([providerError(status), providerError(status), providerError(status)]);
    expect((await exhausted.extractor.extract(input())).status).toBe('error');
    expect(exhausted.requests).toHaveLength(3);
    expect(exhausted.runs().map((w) => w.body.status)).toEqual(['error', 'error', 'error']);
    expect(exhausted.extractions()).toEqual([]);
  }
});

it('erro permanente não tem retry e registra falha', async () => {
  const h = harness([providerError(400)]);
  expect((await h.extractor.extract(input())).status).toBe('error');
  expect(h.requests).toHaveLength(1);
  expect(h.runs().map((w) => w.body.status)).toEqual(['error']);
  expect(h.extractions()).toEqual([]);
  expect(h.delays).toEqual([]);
});
