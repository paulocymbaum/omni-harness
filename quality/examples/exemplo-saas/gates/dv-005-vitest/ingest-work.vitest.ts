// Pendência herdada da DV-004 (spec DV-005, item 3): a ingestão roda o lease-loop no mesmo processo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { execute } from '../../src/cli';

vi.mock('@anthropic-ai/vertex-sdk', () => ({ AnthropicVertex: class { messages = {} }, default: class {} }));
vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Rede externa proibida nos gates DV005'); }));

const debateId = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd5';
const debate = { debateId, isTest: true, status: 'live', startedAt: null, office: 'prefeito', electionCode: 2026, uf: 'SP',
  ibgeCityCode: '3550308', broadcaster: 'TV', asrVocabulary: [], participants: [],
  audioSource: { kind: 'file', uri: null, objectPath: 'test/a.wav', label: null } };
const env = { FLUXO_API_BASE_URL: 'http://127.0.0.1:1', FLUXO_API_AUDIENCE: 'https://audience.example.org',
  SONIOX_API_KEY: 'fake-soniox', VERTEX_PROJECT_ID: 'fluxo-offline', VERTEX_REGION: 'global',
  FACTCHECK_MODEL: 'claude-sonnet-5-5', WEB_SEARCH_PROVIDER: 'none', EMBEDDING_MODEL: 'embedding-gate-768',
  GOOGLE_FACTCHECK_API_KEY: 'fake-key', CIVIC_DATA_BASE_URL: 'https://ofluxo.app/data/civic/2026' };
const fakeApi = () => ({ config: vi.fn(async () => debate), stop: vi.fn(), post: vi.fn(async () => ({ leaseId: null, items: [] })),
  enqueue: vi.fn(), flush: vi.fn(async () => undefined), heartbeat: vi.fn(async () => 'run'), partial: vi.fn(async () => undefined) });

it('ingestão roda o laço de trabalho com extração e checagem e o encerra junto', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dv005-ingest-')), 'a.wav');
  fs.writeFileSync(file, 'RIFF');
  const timeline: string[] = [];
  let workSignal: AbortSignal | undefined;
  const work = vi.fn(async (options: Record<string, any>) => {
    timeline.push('work:start'); workSignal = options.signal;
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) return resolve();
      options.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    timeline.push('work:end');
  });
  const run = vi.fn(async () => { timeline.push('run:start'); await new Promise((r) => setTimeout(r, 30)); timeline.push('run:end'); });
  await execute(['replay', '--file', file, '--debate', debateId], env, { api: fakeApi as never, run, work } as never);
  expect(run).toHaveBeenCalledTimes(1);
  expect(work).toHaveBeenCalledTimes(1);
  expect(work).toHaveBeenCalledWith(expect.objectContaining({ debateId, extractor: expect.anything(), checker: expect.anything() }));
  expect(timeline.indexOf('work:start')).toBeLessThan(timeline.indexOf('run:end'));
  expect(workSignal?.aborted).toBe(true);
  expect(timeline.at(-1)).toMatch(/end$/);
});

it('comando work continua disponível e também leva o checker', async () => {
  const work = vi.fn(async () => undefined);
  await execute(['work', '--debate', debateId], env, { api: fakeApi as never, work } as never);
  expect(work).toHaveBeenCalledWith(expect.objectContaining({ debateId, extractor: expect.anything(), checker: expect.anything() }));
});
