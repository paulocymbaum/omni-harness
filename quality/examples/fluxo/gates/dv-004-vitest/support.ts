// Fixtures e portas falsas pertencem ao harness, não ao implementador.
import { expect, vi } from 'vitest';
import { createExtractor } from '../../src/extract/extractor';

const vertexState = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));
export function vertexOptions() { return vertexState.options; }
vi.mock('@anthropic-ai/vertex-sdk', () => {
  class AnthropicVertex {
    constructor(options: Record<string, unknown>) { vertexState.options.push(options); }
    messages = {
      parse: async () => { throw new Error('Vertex real proibido no gate: injete o cliente'); },
      create: async () => { throw new Error('Vertex real proibido no gate: injete o cliente'); },
    };
  }
  return { AnthropicVertex, default: AnthropicVertex };
});
vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Rede externa proibida nos gates DV004'); }));

export const ids = {
  debate: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
  lease: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
  item: 'ffffffff-ffff-4fff-8fff-fffffffffff1',
  candidate: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  other: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
  moderator: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
  question: 'abababab-abab-4aba-8aba-abababababa1',
  unknown: 'acacacac-acac-4aca-8aca-acacacacaca1',
};

export const debate = {
  debateId: ids.debate, isTest: true, status: 'live', startedAt: '2026-10-21T20:00:00Z',
  office: 'prefeito', electionCode: 2026, uf: 'SP', ibgeCityCode: '3550308',
  broadcaster: 'Emissora de teste', audioSource: { kind: 'file', uri: null, objectPath: 'test/audio.wav', label: 'ensaio' },
  asrVocabulary: [],
  participants: [
    { id: ids.candidate, ballotName: 'Ana', party: 'PA', tseCandidateNumber: 11, displayOrder: 1, role: 'candidate' },
    { id: ids.other, ballotName: 'Bruno', party: 'PB', tseCandidateNumber: 22, displayOrder: 2, role: 'candidate' },
    { id: ids.moderator, ballotName: 'Mediadora', party: null, tseCandidateNumber: null, displayOrder: 3, role: 'moderator' },
  ],
};

export function input(text = 'O desemprego caiu para 5,3% no último trimestre.', participantId: string | null = ids.candidate) {
  return {
    debateId: ids.debate, leaseId: ids.lease, debate: structuredClone(debate),
    item: {
      itemId: ids.item, kind: 'extract',
      utterance: { id: ids.item, text, participantId, speakerLabel: '1:0', startSec: 10, endSec: 20, blockId: null },
      context: [
        { utteranceId: 'fefefefe-fefe-4fef-8fef-fefefefefef1', participantId: ids.moderator,
          speakerLabel: '1:2', text: 'Agora falaremos de serviços públicos.', startSec: 0 },
      ],
      participants: structuredClone(debate.participants),
      openQuestions: [{ questionId: ids.question, text: 'Como reduzirá a violência?',
        askedByParticipantId: ids.moderator, directedToParticipantId: ids.other }],
      block: { blockId: 'bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcb1', ordinal: 1, title: 'Perguntas da mediação' },
    },
  };
}

export function blank() {
  return {
    claims: [] as Record<string, unknown>[],
    question: { exists: false, addresseeParticipantId: '', topic: '', text: '' },
    answerToPrevious: { exists: false, questionId: '', status: 'answered', summary: '' },
  };
}

export function claim(overrides: Record<string, unknown> = {}) {
  return { quote: 'O desemprego caiu para 5,3% no último trimestre',
    normalized: 'O desemprego caiu para 5,3% no último trimestre.', type: 'number', topic: 'emprego',
    priority: 1, checkable: true, discardReason: null, ...overrides };
}

export function output(overrides: Record<string, unknown> = {}) {
  return { ...blank(), claims: [claim()], ...overrides };
}

export function response(parsed = output(), overrides: Record<string, unknown> = {}) {
  return { id: 'msg-offline', type: 'message', role: 'assistant', model: 'claude-haiku-5-5',
    content: [{ type: 'text', text: JSON.stringify(parsed) }], parsed_output: parsed,
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 45, cache_creation_input_tokens: 80, cache_read_input_tokens: 64 },
    ...overrides };
}

export function providerError(status: number) {
  return Object.assign(new Error(`Provider HTTP ${status}`), { status });
}

export function harness(script: unknown[] = [response()], overrides: Record<string, unknown> = {}) {
  const requests: Record<string, any>[] = [];
  const writes: { route: string; body: Record<string, any>; key: string }[] = [];
  const events: string[] = [];
  const delays: number[] = [];
  let tick = 1_000;
  const call = async (request: Record<string, any>) => {
    requests.push(structuredClone(request)); events.push('model');
    const next = script[requests.length - 1];
    if (next instanceof Error) throw next;
    if (!next) throw new Error('Chamada ao modelo não prevista pela fixture');
    return structuredClone(next);
  };
  const client = { messages: { parse: vi.fn(call), create: vi.fn(call) } };
  const api = { post: vi.fn(async (route: string, body: Record<string, any>, key: string) => {
    writes.push({ route, body: structuredClone(body), key });
    if (route.endsWith('/ai-runs')) {
      events.push('ai-run');
      const n = writes.filter((w) => w.route.endsWith('/ai-runs')).length;
      return { aiRunId: `adadadad-adad-4ada-8ada-adadadadada${n}` };
    }
    if (route.endsWith('/extractions')) {
      events.push('extraction');
      return { claims: [], questionIds: [], answerIds: [] };
    }
    throw new Error(`Rota inesperada: ${route}`);
  }) };
  const options = { client, api, model: 'claude-haiku-5-5', region: 'global',
    sleep: async (ms: number) => { delays.push(ms); }, random: () => 0.5, now: () => (tick += 5), ...overrides };
  const extractor = createExtractor(options);
  return { extractor, client, api, requests, writes, events, delays,
    runs: () => writes.filter((w) => w.route.endsWith('/ai-runs')),
    extractions: () => writes.filter((w) => w.route.endsWith('/extractions')) };
}

export function expectedPayload(arg: ReturnType<typeof input>, claims = [claim()], question: unknown = null, answer: unknown = null) {
  return { leaseId: arg.leaseId, utteranceId: arg.item.utterance.id,
    aiRunId: 'adadadad-adad-4ada-8ada-adadadadada1', promptVersion: expect.stringMatching(/^extract-v\d+-[a-f0-9]{12}$/),
    claims: claims.map((c) => ({ ...c, quoteStart: arg.item.utterance.text.indexOf(String(c.quote)),
      quoteEnd: arg.item.utterance.text.indexOf(String(c.quote)) + String(c.quote).length })), question, answer };
}

