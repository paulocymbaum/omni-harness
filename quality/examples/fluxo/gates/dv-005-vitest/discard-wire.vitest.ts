// Pendência herdada da DV-004 (spec DV-005, item 1): motivos de descarte no wire alinhados ao DiscardReasonCode.
import { expect, it, vi } from 'vitest';
import { createExtractor } from '../../src/extract/extractor';

vi.mock('@anthropic-ai/vertex-sdk', () => ({ AnthropicVertex: class { messages = {} }, default: class {} }));
vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Rede externa proibida nos gates DV005'); }));

const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const text = 'O desemprego caiu para 5,3%. Vou cuidar de tudo. A obra custou caro.';
const participants = [{ id: id(1), ballotName: 'Ana', party: 'PA', tseCandidateNumber: 11, displayOrder: 1, role: 'candidate' }];
const debate = { debateId: id(9), isTest: true, status: 'live', startedAt: '2026-10-21T20:00:00Z', office: 'prefeito',
  electionCode: 2026, uf: 'SP', ibgeCityCode: '3550308', broadcaster: 'TV', asrVocabulary: [], participants,
  audioSource: { kind: 'file', uri: null, objectPath: 'a.wav', label: null } };
const claim = (quote: string, o: Record<string, unknown>) => ({ quote, normalized: `${quote}.`, type: 'other', topic: 'gestão',
  priority: 3, checkable: false, ...o });
const output = { claims: [
  claim('O desemprego caiu para 5,3%', { type: 'number', topic: 'emprego', priority: 1, checkable: true, discardReason: 'none' }),
  claim('Vou cuidar de tudo', { type: 'promise', discardReason: 'vague_promise' }),
  claim('A obra custou caro', { discardReason: 'not_verifiable' }),
], question: { exists: false, addresseeParticipantId: '', topic: '', text: '' },
answerToPrevious: { exists: false, questionId: '', status: 'answered', summary: '' } };

it('wire usa DiscardReasonCode: not_verifiable vira not_checkable e none deixa de existir', async () => {
  const response = { content: [{ type: 'text', text: JSON.stringify(output) }], parsed_output: output, stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
  const client = { messages: { create: vi.fn(async () => structuredClone(response)), parse: vi.fn(async () => structuredClone(response)) } };
  const writes: { route: string; body: Record<string, any> }[] = [];
  const api = { post: vi.fn(async (route: string, body: Record<string, any>) => {
    writes.push({ route, body: structuredClone(body) });
    return route.endsWith('/ai-runs') ? { aiRunId: id(7) } : { claims: [], questionIds: [], answerIds: [] };
  }) };
  const extractor = createExtractor({ client, api, model: 'claude-haiku-5-5', region: 'global', sleep: async () => undefined,
    random: () => 0.5, now: () => 1 } as never);
  const result = await extractor.extract({ debateId: debate.debateId, leaseId: id(8), debate: debate as never, item: {
    itemId: id(5), kind: 'extract', utterance: { id: id(5), text, participantId: id(1), speakerLabel: '1:0', startSec: 1, endSec: 9, blockId: null },
    context: [], participants, openQuestions: [], block: null } as never });
  expect(result.status).toBe('ok');
  const extraction = writes.find((w) => w.route.endsWith('/extractions'));
  expect(extraction).toBeDefined();
  const claims = extraction!.body.claims as Record<string, any>[];
  expect(claims.map((c) => [c.checkable, c.discardReason ?? null, c.priority])).toEqual([
    [true, null, 1], [false, 'vague_promise', 3], [false, 'not_checkable', 3]]);
  expect(JSON.stringify(extraction!.body)).not.toMatch(/"(none|not_verifiable)"/);
});
