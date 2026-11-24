import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SECRET, URLS, events, harness, input, net, reset } from './support';

const logged: string[] = [];
beforeEach(() => {
  reset(); logged.length = 0;
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { logged.push(args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')); });
  }
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => { logged.push(String(chunk)); return out(chunk as never, ...(rest as [])); }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => { logged.push(String(chunk)); return err(chunk as never, ...(rest as [])); }) as never);
});
afterEach(() => { vi.restoreAllMocks(); });

const factCalls = () => net.calls.filter((c) => new URL(c.url).hostname === 'factchecktools.googleapis.com');

it('consulta claims:search com query normalizada, languageCode=pt, pageSize=10 e chave', async () => {
  const h = harness({ config: { WEB_SEARCH_PROVIDER: 'none' } });
  await h.pipeline.check(input());
  expect(factCalls()).toHaveLength(1);
  const url = new URL(factCalls()[0].url);
  expect(url.origin + url.pathname).toBe('https://factchecktools.googleapis.com/v1alpha1/claims:search');
  expect(url.searchParams.get('query')).toBe(input().item.claim.normalizedText);
  expect(url.searchParams.get('languageCode')).toBe('pt');
  expect(url.searchParams.get('pageSize')).toBe('10');
  expect(url.searchParams.get('key')).toBe(SECRET);
});

it('mapeia claimReview para fontes fact_check com veículo, data e selo', async () => {
  const h = harness({ config: { WEB_SEARCH_PROVIDER: 'none' } });
  await h.pipeline.check(input());
  const prompt = JSON.stringify(h.verdictRequests()[0].messages);
  expect(prompt).toContain('Exagerado');
  expect(prompt).toContain('Agência Lupa');
  const sources = h.drafts()[0].body.sources as Record<string, any>[];
  expect(sources.find((s) => s.url === URLS.lupa)).toMatchObject({ kind: 'fact_check', outlet: 'Agência Lupa',
    title: 'É exagerado dizer que o desemprego caiu para 5,3%', publishedAt: expect.stringMatching(/^2026-10-02/) });
  expect(sources.find((s) => s.url === URLS.aosfatos)).toMatchObject({ kind: 'fact_check', outlet: 'aosfatos.org' });
});

it('chave nunca aparece em log nem em corpo enviado à API', async () => {
  net.factcheck = () => { throw new Error(`boom https://factchecktools.googleapis.com/v1alpha1/claims:search?key=${SECRET}`); };
  const h = harness({ config: { WEB_SEARCH_PROVIDER: 'none' } });
  await h.pipeline.check(input());
  expect(logged.join('\n')).not.toContain(SECRET);
  expect(JSON.stringify(h.writes)).not.toContain(SECRET);
  expect(JSON.stringify(h.requests)).not.toContain(SECRET);
});

it('cada consulta gera ai-run factcheck_lookup sem tokens', async () => {
  const h = harness({ config: { WEB_SEARCH_PROVIDER: 'none' } });
  await h.pipeline.check(input());
  const lookups = h.runs().filter((r) => r.body.kind === 'factcheck_lookup');
  expect(lookups).toHaveLength(1);
  expect(lookups[0].body.inputTokens ?? 0).toBe(0);
  expect(lookups[0].body.outputTokens ?? 0).toBe(0);
});

it('erro, HTTP 500 ou resposta vazia não interrompem o pipeline', async () => {
  for (const mode of ['throw', 'empty'] as const) {
    reset();
    if (mode === 'throw') net.fail.add('factchecktools.googleapis.com'); else net.factcheck = () => ({});
    const h = harness({ config: { WEB_SEARCH_PROVIDER: 'none' } });
    await h.pipeline.check(input());
    expect(h.drafts(), mode).toHaveLength(1);
    expect(events.filter((e) => e === 'verdict'), mode).toHaveLength(1);
  }
});
