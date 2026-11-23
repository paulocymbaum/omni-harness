import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { blank, claim, harness, ids, input, output, response } from './support';
import { ExtractionOutput } from '../../src/extract/schema';

it('schema rejeita campos ausentes, null, prioridade inválida e enums desconhecidos', () => {
  expect(ExtractionOutput.safeParse(output()).success).toBe(true);
  const malformed = [
    {}, { ...output(), question: null }, { ...output(), answerToPrevious: null },
    output({ claims: [claim({ priority: 0 })] }), output({ claims: [claim({ priority: 1.5 })] }),
    output({ claims: [claim({ priority: 4 })] }), output({ claims: [claim({ type: 'invented_type' })] }),
    output({ claims: [claim({ discardReason: 'invented_reason' })] }),
  ];
  for (const candidate of malformed) expect(ExtractionOutput.safeParse(candidate).success).toBe(false);

  // Lista canônica lida do backend, sem espelho inventado pelo gate.
  const cs = fs.readFileSync(path.resolve(process.cwd(), '../../backend/src/Fluxo.Api/Modules/Debates/DebateEnums.cs'), 'utf8');
  const values = (name: string) => cs.match(new RegExp(`enum\\s+${name}\\s*\\{([^}]+)\\}`))![1]
    .split(',').map((s) => s.trim().replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase());
  for (const type of values('ClaimType')) {
    expect(ExtractionOutput.safeParse(output({ claims: [claim({ type })] })).success, type).toBe(true);
  }
  for (const status of values('AnswerStatus')) {
    const candidate = { ...blank(), answerToPrevious: { exists: true, questionId: ids.question, status, summary: 'Resumo' } };
    expect(ExtractionOutput.safeParse(candidate).success, status).toBe(true);
  }
});

it('remove citação inventada e conta invalidItems', async () => {
  const h = harness([response(output({ claims: [claim({ quote: 'A pobreza caiu para zero.' }), claim()] }))]);
  await h.extractor.extract(input());
  expect(h.extractions()).toHaveLength(1);
  expect(h.extractions()[0].body.claims).toHaveLength(1);
  expect(h.extractions()[0].body.claims[0].quote).toBe(claim().quote);
  expect(h.runs()[0].body.invalidItems).toBe(1);
});

it('calcula offsets UTF-16 preservando espaços originais', async () => {
  const actualQuote = 'O desemprego \t caiu para 5,3%';
  const text = `📢 Dados: ${actualQuote} no último trimestre.`;
  const h = harness([response(output({ claims: [claim({ quote: 'O desemprego caiu para 5,3%',
    normalized: 'O desemprego caiu para 5,3%.' })] }))]);
  await h.extractor.extract(input(text));
  const c = h.extractions()[0].body.claims[0];
  expect(c.quote).toBe(actualQuote);
  expect(c.quoteStart).toBe(text.indexOf(actualQuote));
  expect(c.quoteEnd).toBe(text.indexOf(actualQuote) + actualQuote.length);
  expect(text.slice(c.quoteStart, c.quoteEnd)).toBe(c.quote);
});

it('rebaixa número inventado para não verificável', async () => {
  const h = harness([response(output({ claims: [claim({ normalized: 'O desemprego caiu para 4,1% em 2019.' })] }))]);
  await h.extractor.extract(input());
  expect(h.extractions()).toHaveLength(1);
  expect(h.extractions()[0].body.claims[0]).toMatchObject({ checkable: false, discardReason: 'not_checkable' });
});

it('reconhece números em milhões e por extenso sem falso descarte', async () => {
  for (const text of ['Atendemos 14 milhões de pessoas.', 'Atendemos quatorze milhões de pessoas.']) {
    const h = harness([response(output({ claims: [claim({ quote: text,
      normalized: 'Foram atendidas 14 mi de pessoas.' })] }))]);
    await h.extractor.extract(input(text));
    expect(h.extractions()).toHaveLength(1);
    expect(h.extractions()[0].body.claims[0]).toMatchObject({ checkable: true, discardReason: null });
  }
});

it('normaliza caixa de enums antes da validação final', async () => {
  const result = output({ claims: [claim({ type: 'NUMBER', discardReason: 'NONE' })],
    answerToPrevious: { exists: true, questionId: ids.question, status: 'EVADED', summary: 'Mudou de assunto.' } });
  const h = harness([response(result)]);
  await h.extractor.extract(input());
  expect(h.extractions()).toHaveLength(1);
  expect(h.extractions()[0].body.claims[0]).toMatchObject({ type: 'number', discardReason: null });
  expect(h.extractions()[0].body.answer.status).toBe('evaded');
});

it('anula destinatário e pergunta anterior desconhecidos', async () => {
  const result = { ...blank(),
    question: { exists: true, addresseeParticipantId: ids.unknown, topic: 'saúde', text: 'Qual é o plano?' },
    answerToPrevious: { exists: true, questionId: ids.unknown, status: 'answered', summary: 'Respondeu.' } };
  const h = harness([response(result)]);
  await h.extractor.extract(input());
  expect(h.extractions()).toHaveLength(1);
  expect(h.extractions()[0].body.question).toBeNull();
  expect(h.extractions()[0].body.answer).toBeNull();
});

it('remove textos vazios e limita resumo a 280 caracteres', async () => {
  const result = output({ claims: [claim({ normalized: '  ' }), claim({ quote: ' ' })],
    question: { exists: true, addresseeParticipantId: ids.other, topic: 'saúde', text: '   ' },
    answerToPrevious: { exists: true, questionId: ids.question, status: 'partial', summary: 'a'.repeat(350) } });
  const h = harness([response(result)]);
  await h.extractor.extract(input());
  expect(h.extractions()).toHaveLength(1);
  expect(h.extractions()[0].body.claims).toEqual([]);
  expect(h.extractions()[0].body.question).toBeNull();
  expect(h.extractions()[0].body.answer.summary).toBe('a'.repeat(280));
});

it('rejeita contradição entre checkable e discardReason', async () => {
  for (const c of [claim({ checkable: true, discardReason: 'opinion' }), claim({ checkable: false, discardReason: 'none' })]) {
    const h = harness([response(output({ claims: [c] }))]);
    await h.extractor.extract(input());
    expect(h.extractions().flatMap((w) => w.body.claims)).toEqual([]);
    expect(h.runs()).toHaveLength(1);
    // Rejeitar a saída inteira ou apenas o item é válido; a contradição nunca sai do worker.
    expect(h.runs()[0].body.status === 'invalid_output' || h.runs()[0].body.invalidItems > 0).toBe(true);
  }
});

it('refusal gera auditoria sem extração nem retry', async () => {
  const h = harness([response(output(), { stop_reason: 'refusal' })]);
  expect((await h.extractor.extract(input())).status).toBe('refusal');
  expect(h.requests).toHaveLength(1);
  expect(h.runs().map((w) => w.body.status)).toEqual(['refusal']);
  expect(h.extractions()).toEqual([]);
  expect(h.delays).toEqual([]);
});

it('max_tokens repete uma vez com 4096 e audita ambas as chamadas', async () => {
  const h = harness([response(output(), { stop_reason: 'max_tokens' }), response()]);
  expect((await h.extractor.extract(input())).status).toBe('ok');
  expect(h.requests.map((r) => r.max_tokens)).toEqual([2048, 4096]);
  expect(h.runs().map((w) => w.body.status)).toEqual(['max_tokens', 'ok']);
  expect(h.extractions()).toHaveLength(1);
  expect(h.extractions()[0].body.aiRunId).toBe('adadadad-adad-4ada-8ada-adadadadada2');
  expect(h.runs().map((w) => w.key)).toEqual([1, 2].map((n) => `airun:${ids.lease}:${ids.item}:${n}`));
});

it('max_tokens persistente termina sem extração', async () => {
  const h = harness([response(output(), { stop_reason: 'max_tokens' }), response(output(), { stop_reason: 'max_tokens' })]);
  expect((await h.extractor.extract(input())).status).toBe('max_tokens');
  expect(h.requests.map((r) => r.max_tokens)).toEqual([2048, 4096]);
  expect(h.runs().map((w) => w.body.status)).toEqual(['max_tokens', 'max_tokens']);
  expect(h.extractions()).toEqual([]);
});

it('JSON inválido gera invalid_output sem extração', async () => {
  const h = harness([response(output(), { parsed_output: undefined, content: [{ type: 'text', text: '{quebrado' }] })]);
  expect((await h.extractor.extract(input())).status).toBe('invalid_output');
  expect(h.runs().map((w) => w.body.status)).toEqual(['invalid_output']);
  expect(h.extractions()).toEqual([]);
});

it('revalida parsed_output em vez de confiar na resposta do SDK', async () => {
  const h = harness([response({ claims: [{ quote: 'Texto sem campos obrigatórios' }] } as ReturnType<typeof output>)]);
  expect((await h.extractor.extract(input())).status).toBe('invalid_output');
  expect(h.runs().map((w) => w.body.status)).toEqual(['invalid_output']);
  expect(h.extractions()).toEqual([]);
});

it('falha ao registrar ai-run impede envio da extração', async () => {
  const h = harness();
  h.api.post.mockRejectedValue(Object.assign(new Error('API indisponível'), { status: 503 }));
  // A política de erro da API pode propagar ou devolver error; nenhuma extração sem aiRunId é aceita.
  await h.extractor.extract(input()).catch(() => undefined);
  expect(h.requests).toHaveLength(1);
  expect(h.api.post.mock.calls.length).toBeGreaterThan(0);
  expect(h.api.post.mock.calls.every(([route]) => route.endsWith('/ai-runs'))).toBe(true);
});

it('não chama modelo nem API para falante não confirmado', async () => {
  const h = harness();
  expect((await h.extractor.extract(input(undefined, null))).status).toBe('ignored');
  expect(h.requests).toEqual([]);
  expect(h.writes).toEqual([]);
});
