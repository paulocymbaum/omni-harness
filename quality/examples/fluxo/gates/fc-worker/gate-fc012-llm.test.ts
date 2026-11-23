// Gates FC-012 no nível do worker — cliente LLM OpenAI-compatible (template; copiado para src/ pelo gate fc-012).
// Sem rede: o fetch é injetável e os testes usam respostas sintéticas. Contrato do gate:
//   createLlmClient({ baseUrl, apiKey, model, fetch?, budgetPerSecond? = 2 }) -> { completeJson(messages, schemaName, schema) }
//   429 com Retry-After -> JobFailure provider:true retryable:true retryAfterMs (clamp 1..600_000)
//   5xx/rede -> provider_unavailable (provider:true); 4xx -> llm_request_invalid (sem provider, sem retentativa)
import { describe, expect, it, vi } from 'vitest';

import { createLlmClient } from './ai/llm-client.js';
import { JobFailure } from './handlers/registry.js';

const OK = (json) => new Response(JSON.stringify({ choices: [{ message: { content: `Aqui está:\n${JSON.stringify(json)}` } }] }), { status: 200 });
const SCHEMA = { type: 'object' };

function clientOf(fetchImpl, budget = 10) {
  return createLlmClient({ baseUrl: 'https://llm.test/v1', apiKey: 'chave', model: 'modelo', fetch: fetchImpl, budgetPerSecond: budget });
}

describe('FC-012 cliente LLM', () => {
  it('fala OpenAI-compatible (chat/completions, Bearer, modelo no corpo) e extrai o JSON do texto', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const client = clientOf(async (url: string | URL, init: RequestInit = {}) => {
      seen.push({ url: String(url), init });
      return OK({ balloons: [{ role: 'title', text: 'Título' }] });
    });
    const { json } = await client.completeJson([{ role: 'user', content: 'gere' }], 'copy', SCHEMA);
    expect(json).toEqual({ balloons: [{ role: 'title', text: 'Título' }] });
    expect(seen[0].url).toContain('/chat/completions');
    expect((seen[0].init.headers as Record<string, string>)['Authorization']).toBe('Bearer chave');
    expect(String(seen[0].init.body)).toContain('"modelo"');
  });

  it('respeita o orçamento de 2 req/s: a terceira chamada em rajada espera o período', async () => {
    const fetchImpl = vi.fn(async () => OK({ ok: true }));
    const client = clientOf(fetchImpl, 2);
    const started = Date.now();
    await Promise.all([client.completeJson([], 's', SCHEMA), client.completeJson([], 's', SCHEMA), client.completeJson([], 's', SCHEMA)]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  }, 20_000);

  it('429 com Retry-After vira falha de provedor retentável com retryAfterMs em ms', async () => {
    const client = clientOf(async () => new Response('lento', { status: 429, headers: { 'retry-after': '3' } }));
    const error = await client.completeJson([], 's', SCHEMA).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobFailure);
    expect(error).toMatchObject({ code: 'provider_rate_limited', provider: true, retryable: true, retryAfterMs: 3000 });
  });

  it('5xx e erro de rede são de provedor; 4xx é pedido inválido sem provider e sem retentativa', async () => {
    const down = clientOf(async () => new Response('boom', { status: 503 }));
    const downError = await down.completeJson([], 's', SCHEMA).catch((e: unknown) => e);
    expect(downError).toMatchObject({ code: 'provider_unavailable', provider: true, retryable: true });
    const broken = clientOf(async () => { throw new Error('socket'); });
    const netError = await broken.completeJson([], 's', SCHEMA).catch((e: unknown) => e);
    expect(netError).toMatchObject({ code: 'provider_unavailable', provider: true });
    const bad = clientOf(async () => new Response('schema ruim', { status: 400 }));
    const badError = await bad.completeJson([], 's', SCHEMA).catch((e: unknown) => e);
    expect(badError).toMatchObject({ code: 'llm_request_invalid', provider: false, retryable: false });
  });

  it('resposta sem JSON válido falha sem retentativa e sem virar erro de terceiros', async () => {
    const client = clientOf(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'sem json aqui' } }] }), { status: 200 }));
    const error = await client.completeJson([], 's', SCHEMA).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobFailure);
    expect((error as JobFailure).retryable).toBe(false);
    expect((error as JobFailure).provider).toBe(false);
  });
});
