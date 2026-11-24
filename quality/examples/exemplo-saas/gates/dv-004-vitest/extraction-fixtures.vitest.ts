import { expect, it } from 'vitest';
import { blank, claim, expectedPayload, harness, ids, input, output, response } from './support';

it('preserva número e citação com offsets reais', async () => {
  const arg = input('Os dados mostram: O desemprego caiu para 5,3% no último trimestre.');
  const h = harness();
  expect((await h.extractor.extract(arg)).status).toBe('ok');
  expect(h.extractions()).toHaveLength(1);
  expect(h.extractions()[0].body).toEqual(expectedPayload(arg));
  expect(h.extractions()[0].route).toBe(`/api/v1/internal/debates/${ids.debate}/extractions`);
  expect(h.extractions()[0].key).toBe(`extract:${ids.item}:${h.extractions()[0].body.promptVersion}`);
});

it('envia promessa concreta com prioridade três', async () => {
  const arg = input('Vou construir 500 creches até 2030.');
  const c = claim({ quote: 'Vou construir 500 creches até 2030',
    normalized: 'A candidata construirá 500 creches até 2030.', type: 'promise', topic: 'educação', priority: 3 });
  const h = harness([response(output({ claims: [c] }))]);
  await h.extractor.extract(arg);
  expect(h.extractions()).toHaveLength(1);
  expect(h.extractions()[0].body).toEqual(expectedPayload(arg, [c]));
});

it('envia opinião como descartada', async () => {
  const arg = input('Esse governo é um desastre.');
  const c = claim({ quote: 'Esse governo é um desastre', normalized: 'Esse governo é um desastre.',
    type: 'other', topic: 'gestão', priority: 3, checkable: false, discardReason: 'opinion' });
  const h = harness([response(output({ claims: [c] }))]);
  await h.extractor.extract(arg);
  expect(h.extractions()).toHaveLength(1);
  expect(h.extractions()[0].body).toEqual(expectedPayload(arg, [c]));
});

it('envia pergunta ao destinatário conhecido', async () => {
  const arg = input('Candidato Bruno, o que fará pela saúde?', ids.moderator);
  const question = { addresseeParticipantId: ids.other, topic: 'saúde', text: arg.item.utterance.text };
  const h = harness([response({ ...blank(), question: { exists: true, ...question } })]);
  await h.extractor.extract(arg);
  expect(h.extractions()).toHaveLength(1);
  expect(h.extractions()[0].body).toEqual(expectedPayload(arg, [], question));
});

it('liga resposta evasiva à pergunta aberta', async () => {
  const arg = input('Vamos falar de educação e ampliar as escolas.', ids.other);
  const answer = { questionId: ids.question, status: 'evaded',
    summary: 'O candidato mudou o tema de segurança para educação.' };
  const h = harness([response({ ...blank(), answerToPrevious: { exists: true, ...answer } })]);
  await h.extractor.extract(arg);
  expect(h.extractions()).toHaveLength(1);
  expect(h.extractions()[0].body).toEqual(expectedPayload(arg, [], null, answer));
});
