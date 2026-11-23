import { beforeEach, expect, it } from 'vitest';
import { allSources, everyToken, harness, ids, input, item, reset, verdict } from './support';

beforeEach(() => reset());
const none = { WEB_SEARCH_PROVIDER: 'none' };

it('veredito usa FACTCHECK_MODEL, structured output e cache_control no fim do system estável', async () => {
  const h = harness({ config: none });
  await h.pipeline.check(input());
  const [request] = h.verdictRequests();
  expect(request.model).toBe('claude-sonnet-5-5');
  expect(request.output_config?.format?.type).toBe('json_schema');
  expect(request.output_config.format.schema?.properties).toEqual(expect.objectContaining({
    verdict: expect.anything(), explanation: expect.anything(), normalizedClaim: expect.anything(),
    sourceIds: expect.anything(), confidence: expect.anything() }));
  expect(Array.isArray(request.system)).toBe(true);
  expect(request.system.at(-1).cache_control).toEqual({ type: 'ephemeral' });
  expect(request.tools ?? []).toEqual([]);
  const text = JSON.stringify(request.messages);
  expect(text).toContain('O desemprego caiu para 5,3% no último trimestre');
  expect(text).toContain('Ana');
});

it('remove sourceIds inventados e publica só fontes da lista enviada', async () => {
  const h = harness({ config: none });
  await h.pipeline.check(input());
  const sources = h.drafts()[0].body.sources as Record<string, any>[];
  expect(sources.length).toBeGreaterThan(0);
  const prompt = JSON.stringify(h.verdictRequests()[0].messages);
  for (const s of sources) expect(prompt).toContain(s.url);
  expect(JSON.stringify(h.drafts()[0].body)).not.toContain('fonte-inventada-999');
});

it('sem fonte válida o veredito vira no_data', async () => {
  const h = harness({ config: none, verdicts: [verdict({ verdict: 'false', explanation: 'Não confere.',
    normalizedClaim: 'O desemprego caiu para 5,3%.', sourceIds: ['fonte-inventada-999'], confidence: 0.9 })] });
  await h.pipeline.check(input());
  expect(h.drafts()).toHaveLength(1);
  expect(h.drafts()[0].body).toMatchObject({ verdict: 'no_data', sources: [] });
});

it('normaliza caixa do enum e limita confidence a [0, 1]', async () => {
  const h = harness({ config: none, verdicts: [(r: Record<string, any>) => verdict({ verdict: 'EXAGGERATED',
    explanation: 'A taxa oficial é 5,6%.', normalizedClaim: 'O desemprego caiu para 5,3%.', sourceIds: everyToken(r), confidence: 1.7 })] });
  await h.pipeline.check(input());
  expect(h.drafts()[0].body).toMatchObject({ verdict: 'exaggerated', confidence: 1 });
});

it('explicação acima de 280 tenta de novo e, persistindo, corta na última frase completa', async () => {
  const long = `${'A taxa oficial de desocupação do IBGE é maior que a citada pela candidata no debate. '.repeat(4)}Fim.`;
  const step = (r: Record<string, any>) => verdict({ verdict: 'exaggerated', explanation: long,
    normalizedClaim: 'O desemprego caiu para 5,3%.', sourceIds: everyToken(r), confidence: 0.7 });
  const h = harness({ config: none, verdicts: [step, step] });
  await h.pipeline.check(input());
  expect(h.verdictRequests()).toHaveLength(2);
  const explanation = h.drafts()[0].body.explanation as string;
  expect(explanation.length).toBeLessThanOrEqual(280);
  expect(explanation.length).toBeGreaterThan(0);
  expect(long.startsWith(explanation)).toBe(true);
  expect(explanation.endsWith('.')).toBe(true);
});

it('refusal não envia ai-draft e registra ai-run verdict com status', async () => {
  const h = harness({ config: none, verdicts: [verdict({}, { stop_reason: 'refusal', parsed_output: null,
    content: [{ type: 'text', text: '' }] })] });
  const result = await h.pipeline.check(input());
  expect(h.drafts()).toEqual([]);
  expect(result.status).not.toBe('ok');
  expect(h.runs().filter((r) => r.body.kind === 'verdict').map((r) => r.body.status)).toEqual(['refusal']);
});

it('redo leva a instrução do checador ao prompt e o requestId ao ai-draft', async () => {
  const redo = { instruction: 'Use a PNAD trimestral mais recente', requestId: ids.redo, previousRevisionId: null };
  const h = harness({ config: none, verdicts: [allSources] });
  await h.pipeline.check(input(item({ redo })));
  expect(JSON.stringify(h.verdictRequests()[0].messages)).toContain('Use a PNAD trimestral mais recente');
  expect(h.drafts()[0].body.redoRequestId).toBe(ids.redo);
});

it('ai-run verdict antecede o ai-draft e carrega promptVersion e aiRunId', async () => {
  const h = harness({ config: none });
  await h.pipeline.check(input());
  const verdictRun = h.writes.findIndex((w) => w.route.endsWith('/ai-runs') && w.body.kind === 'verdict');
  const draft = h.writes.findIndex((w) => w.route.endsWith('/ai-draft'));
  expect(verdictRun).toBeGreaterThanOrEqual(0);
  expect(verdictRun).toBeLessThan(draft);
  const run = h.writes[verdictRun].body;
  const runNo = h.runs().findIndex((r) => r.body.kind === 'verdict') + 1;
  expect(run.model).toBe('claude-sonnet-5-5');
  expect(run.promptVersion).toBe(h.drafts()[0].body.promptVersion);
  expect(String(run.promptVersion)).not.toBe('');
  expect(h.drafts()[0].body.aiRunId).toBe(`adadadad-adad-4ada-8ada-${String(runNo).padStart(12, '0')}`);
});
