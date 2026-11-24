import { beforeEach, expect, it } from 'vitest';
import { URLS, genai, harness, ids, input, item, reset } from './support';

beforeEach(() => reset());
const none = { WEB_SEARCH_PROVIDER: 'none' };
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function candidate(overrides: Record<string, unknown> = {}) {
  return { factCheckId: ids.reused, claimId: 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c5', debateId: 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d5',
    participantId: ids.candidate, similarity: 0.95, validatedAt: daysAgo(5), verdict: 'false',
    explanation: 'Checagem anterior: a PNAD mostra 5,6%, não 5,3%.', normalizedClaim: 'O desemprego caiu para 5,3%.',
    sources: [{ title: 'PNAD Contínua', url: URLS.reused, outlet: 'IBGE', publishedAt: '2026-09-30', kind: 'official_data' }],
    ...overrides };
}

it('calcula embedding de 768 dimensões com EMBEDDING_MODEL e chama reuse-search da afirmação', async () => {
  const h = harness({ config: none });
  await h.pipeline.check(input());
  expect(genai.embed).toHaveLength(1);
  expect(genai.embed[0].model).toBe('embedding-gate-768');
  expect(JSON.stringify(genai.embed[0])).toContain('O desemprego caiu para 5,3% no último trimestre');
  expect(h.reuseCalls()).toHaveLength(1);
  expect(h.reuseCalls()[0].route).toBe(`/api/v1/internal/claims/${ids.claim}/reuse-search`);
  expect(h.reuseCalls()[0].body.embeddingModel).toBe('embedding-gate-768');
  expect(h.reuseCalls()[0].body.embedding).toHaveLength(768);
  expect(h.runs().some((r) => r.body.kind === 'embedding')).toBe(true);
});

it('atalho: mesmo participante, limiar e idade reaproveitam sem Sonnet e continuam balão', async () => {
  const h = harness({ config: none, reuse: { candidates: [candidate()] } });
  await h.pipeline.check(input());
  expect(h.verdictRequests()).toEqual([]);
  expect(h.drafts()).toHaveLength(1);
  const body = h.drafts()[0].body;
  expect(body).toMatchObject({ reusedFromFactCheckId: ids.reused, verdict: 'false',
    explanation: 'Checagem anterior: a PNAD mostra 5,6%, não 5,3%.' });
  expect((body.sources as Record<string, any>[]).map((s) => s.url)).toEqual([URLS.reused]);
  expect(h.writes.filter((w) => !/\/(ai-runs|reuse-search|ai-draft)$/.test(w.route))).toEqual([]);
});

it('outro participante, similaridade abaixo do limiar ou validação antiga vão ao Sonnet como fonte reused', async () => {
  const cases = [candidate({ participantId: ids.other }), candidate({ similarity: 0.91 }), candidate({ validatedAt: daysAgo(31) })];
  for (const c of cases) {
    reset();
    const h = harness({ config: none, reuse: { candidates: [c] } });
    await h.pipeline.check(input(item()));
    expect(h.verdictRequests()).toHaveLength(1);
    expect(JSON.stringify(h.verdictRequests()[0].messages)).toContain('Checagem anterior: a PNAD mostra 5,6%');
    const body = h.drafts()[0].body;
    expect(body.reusedFromFactCheckId ?? null).toBeNull();
    expect((body.sources as Record<string, any>[]).some((s) => s.kind === 'reused')).toBe(true);
  }
});

it('falha do reuse-search não derruba o item', async () => {
  const h = harness({ config: none, reuse: Object.assign(new Error('API 503'), { status: 503 }) });
  await h.pipeline.check(input());
  expect(h.verdictRequests()).toHaveLength(1);
  expect(h.drafts()).toHaveLength(1);
});
