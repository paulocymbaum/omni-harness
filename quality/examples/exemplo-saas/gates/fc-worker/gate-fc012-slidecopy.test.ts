// Gates FC-012 no nível do worker — handler slide_copy com ficha de fatos, validação determinística e store .json
// (template; copiado para src/ pelo gate fc-012). Sem rede e sem Postgres: a ficha e o LLM são injetados e o store
// aponta para um diretório temporário. Contrato do gate:
//   createSlideCopyHandler({ llm, store, facts: { build(input) }, attempts? = 2 }) — usado na kind slide_copy
//   payload: { factSheetInput, prompt, viewport, maxChars: { title, body, data, cta } }
//   resposta do LLM: { balloons: [{ role, text, factRefs? }] }; validação: número fora de allowedNumbers,
//   chars acima do teto por papel e termo proibido derrubam; até `attempts` chamadas de LLM e depois
//   JobFailure('copy_validation_failed') sem retentativa; LLM fora de schema -> 'copy_schema_invalid'.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ClaimedJob } from './handlers/registry.js';
import { createSlideCopyHandler } from './handlers/slide-copy.js';
import { createLocalResultStore } from './render/store.js';

const FACTS = { version: 1, manifestGeneratedAt: '2026-11-14T00:00:00Z', area: { ibge: '3106200', uf: 'MG', name: 'Belo Horizonte' }, facts: [], unavailable: [], allowedNumbers: [27.5, 1234] };
const PAYLOAD = {
  projectId: '0196a7e1-0000-7000-8000-0000000000c0',
  factSheetInput: { selections: [{ contextId: 'renda', indicatorId: 'renda.media' }], maxIndicators: 3 },
  prompt: 'post sobre renda',
  viewport: { preset: 'feed', width: 1080, height: 1080 },
  maxChars: { title: 60, body: 160, data: 40, cta: 50 },
};
const jobOf = (payload: unknown, id = '0196a7e1-0000-7000-8000-0000000000c1'): ClaimedJob => ({
  id, businessId: 'b', projectId: PAYLOAD.projectId, slideIndex: null, kind: 'slide_copy', lane: 'llm',
  priority: 1, attempts: 1, maxAttempts: 3, deadlineAt: null, payload,
});
const copy = (text: string) => ({ balloons: [{ role: 'data', text, factRefs: ['renda.media'] }] });
const llmOf = (responses: Array<unknown>) => ({ completeJson: vi.fn(async () => ({ json: responses.length > 1 ? responses.shift() : responses[0] })) });

let root: string;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'fc012-')); }, 30_000);
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('FC-012 handler slide_copy', () => {
  it('copy válida: JSON gravado no store como file://<jobId>.json e o conteúdo tem os balões', async () => {
    const store = createLocalResultStore(root);
    const handler = createSlideCopyHandler({ llm: llmOf([copy('A renda média é R$ 1.234')]), store, facts: { build: () => FACTS } });
    const { resultRef } = await handler({ job: jobOf(PAYLOAD), signal: new AbortController().signal });
    expect(resultRef).toBe(`file://${jobOf(PAYLOAD).id}.json`);
    const saved = JSON.parse(await readFile(join(root, `${jobOf(PAYLOAD).id}.json`), 'utf8'));
    expect(saved.balloons[0]).toMatchObject({ role: 'data', text: 'A renda média é R$ 1.234' });
    expect(saved.factSheet).toMatchObject({ area: { uf: 'MG' }, allowedNumbers: [27.5, 1234] });
  }, 30_000);

  it('número fora da ficha: repete o LLM até o teto interno e falha copy_validation_failed sem retentativa', async () => {
    const llm = llmOf([copy('A renda média é R$ 9.999'), copy('A renda média é R$ 9.999')]);
    const handler = createSlideCopyHandler({ llm, store: createLocalResultStore(root), facts: { build: () => FACTS } });
    await expect(handler({ job: jobOf(PAYLOAD), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'copy_validation_failed', retryable: false });
    expect(llm.completeJson).toHaveBeenCalledTimes(2);
  }, 30_000);

  it('termo proibido e balão acima do teto de caracteres também derrubam', async () => {
    const store = createLocalResultStore(root);
    const forbidden = createSlideCopyHandler({ llm: llmOf([copy('Vote no candidato X pela mudança')]), store, facts: { build: () => FACTS } });
    await expect(forbidden({ job: jobOf(PAYLOAD), signal: new AbortController().signal })).rejects.toMatchObject({ code: 'copy_validation_failed' });
    const long = createSlideCopyHandler({ llm: llmOf([copy(`renda ${'a'.repeat(200)}`)]), store, facts: { build: () => FACTS } });
    await expect(long({ job: jobOf(PAYLOAD), signal: new AbortController().signal })).rejects.toMatchObject({ code: 'copy_validation_failed' });
  }, 30_000);
});

describe('FC-012 schema e ficha recusadas', () => {
  it('LLM fora do schema falha copy_schema_invalid sem queimar a segunda tentativa', async () => {
    const llm = llmOf([{ nada: true }]);
    const handler = createSlideCopyHandler({ llm, store: createLocalResultStore(root), facts: { build: () => FACTS } });
    await expect(handler({ job: jobOf(PAYLOAD), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'copy_schema_invalid', retryable: false });
    expect(llm.completeJson).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('ficha que o builder recusa falha sem chamar LLM', async () => {
    const llm = llmOf([copy('ok')]);
    const handler = createSlideCopyHandler({ llm, store: createLocalResultStore(root), facts: { build: () => { throw new Error('too_many_indicators'); } } });
    await expect(handler({ job: jobOf(PAYLOAD), signal: new AbortController().signal })).rejects.toSatisfy((e: { message?: string }) => /too_many_indicators/.test(String(e?.message ?? e)));
    expect(llm.completeJson).not.toHaveBeenCalled();
  }, 30_000);
});

describe('FC-012 store com extensão', () => {
  it('save aceita ext json/png e recusa ext com caminho', async () => {
    const store = createLocalResultStore(root);
    const ref = await store.save('0196a7e1-0000-7000-8000-0000000000c2', new TextEncoder().encode('{}'), 'json');
    expect(ref).toBe('file://0196a7e1-0000-7000-8000-0000000000c2.json');
    await expect(store.save('0196a7e1-0000-7000-8000-0000000000c3', new Uint8Array(1), '../json')).rejects.toThrow();
    const png = await store.save('0196a7e1-0000-7000-8000-0000000000c4', new Uint8Array([1]));
    expect(png).toBe('file://0196a7e1-0000-7000-8000-0000000000c4.png');
  });
});
