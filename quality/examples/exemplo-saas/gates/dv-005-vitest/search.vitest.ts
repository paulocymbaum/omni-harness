import { beforeEach, expect, it } from 'vitest';
import { URLS, genai, harness, ids, input, item, providerError, reset } from './support';

beforeEach(() => reset());

it('claude: busca básica web_search_20250305 em chamada separada, sem output_config', async () => {
  const h = harness();
  await h.pipeline.check(input());
  expect(h.searchRequests()).toHaveLength(1);
  const search = h.searchRequests()[0];
  expect(search.model).toBe('claude-sonnet-5-5');
  expect(search.tools).toEqual([expect.objectContaining({ type: 'web_search_20250305', name: 'web_search', max_uses: 3,
    user_location: expect.objectContaining({ type: 'approximate', country: 'BR', timezone: 'America/Sao_Paulo' }) })]);
  expect(search.output_config?.format).toBeUndefined();
  const [verdictRequest] = h.verdictRequests();
  expect(verdictRequest.output_config?.format?.type).toBe('json_schema');
  expect(verdictRequest.tools ?? []).toEqual([]);
  expect(genai.generate).toEqual([]);
});

it('claude: citações web_search_result_location viram fontes web e ai-run search', async () => {
  const h = harness();
  await h.pipeline.check(input());
  expect(JSON.stringify(h.verdictRequests()[0].messages)).toContain(URLS.web);
  const body = h.drafts()[0].body;
  expect((body.sources as Record<string, any>[]).find((s) => s.url === URLS.web)).toMatchObject({ kind: 'web' });
  expect(body.searchProvider).toBe('claude');
  expect(h.runs().some((r) => r.body.kind === 'search')).toBe(true);
});

it('erro permanente de ferramenta indisponível troca para Gemini até reiniciar', async () => {
  const h = harness({ searches: [providerError(400, 'web_search tool is not available for this model')] });
  await h.pipeline.check(input());
  await h.pipeline.check(input(item({ fact: '12121212-1212-4121-8121-121212121215' })));
  expect(h.searchRequests()).toHaveLength(1);
  expect(genai.generate).toHaveLength(2);
  expect(genai.generate[0].model).toBe('gemini-gate-search');
  expect(JSON.stringify(genai.generate[0].config?.tools ?? genai.generate[0].tools)).toContain('googleSearch');
  expect(h.drafts()).toHaveLength(2);
  for (const d of h.drafts()) {
    expect(d.body.searchProvider).toBe('gemini');
    expect((d.body.sources as Record<string, any>[]).find((s) => s.url === URLS.gemini)).toMatchObject({ kind: 'web' });
  }
});

it('gemini configurado usa grounding e não chama a busca do Claude', async () => {
  const h = harness({ config: { WEB_SEARCH_PROVIDER: 'gemini' } });
  await h.pipeline.check(input());
  expect(h.searchRequests()).toEqual([]);
  expect(genai.generate).toHaveLength(1);
  expect(genai.ctor.some((o) => o.vertexai === true)).toBe(true);
  expect(JSON.stringify(h.verdictRequests()[0].messages)).toContain(URLS.gemini);
});

it('none pula a busca e mantém o veredito', async () => {
  const h = harness({ config: { WEB_SEARCH_PROVIDER: 'none' } });
  await h.pipeline.check(input());
  expect(h.searchRequests()).toEqual([]);
  expect(genai.generate).toEqual([]);
  expect(h.verdictRequests()).toHaveLength(1);
  expect(h.drafts()[0].body).toMatchObject({ searchProvider: 'none', itemId: ids.fact });
});
