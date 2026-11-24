// Harness independente dos gates DV-005: respostas gravadas (Fact Check Tools, SIDRA, SGS, TSE civic,
// Claude busca/veredito, Gemini, embeddings) e portas falsas. Nada aqui é escrito pelo implementador.
//
// Contrato mínimo exigido do worker (spec DV-005 §1, §2, §5, §6):
//   src/check/pipeline.ts  → createCheckPipeline({ client, api, config, now?, sleep? }) → { check(input) }
//     input = { debateId, leaseId, item, debate }  (item = formato real do work:lease `check` da API)
//     check(...) devolve { status }, com status 'lease_expired' quando a API responde 409 lease_expired.
//   src/work/lease-loop.ts → processCheckLease({ debateId, debate, lease, checker }) e runWorkLoop({ ..., checker })
//   Embeddings e Gemini via @google/genai (models.embedContent / models.generateContent), mockado aqui.
//   Rede: fetch global falso; qualquer host fora das fixtures falha.
import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import { createCheckPipeline } from '../../src/check/pipeline';


vi.mock('@anthropic-ai/vertex-sdk', () => {
  class AnthropicVertex {
    messages = {
      parse: async () => { throw new Error('Vertex real proibido no gate: injete o cliente'); },
      create: async () => { throw new Error('Vertex real proibido no gate: injete o cliente'); },
    };
  }
  return { AnthropicVertex, default: AnthropicVertex };
});

const hoisted = vi.hoisted(() => ({
  events: [] as string[],
  genai: {
    ctor: [] as Record<string, unknown>[],
    embed: [] as Record<string, any>[],
    generate: [] as Record<string, any>[],
    script: [] as unknown[],
  },
}));
export const events = hoisted.events;
export const genai = hoisted.genai;

vi.mock('@google/genai', () => {
  const vector = () => Array.from({ length: 768 }, (_, i) => ((i % 13) - 6) / 10);
  class GoogleGenAI {
    constructor(options: Record<string, unknown>) { hoisted.genai.ctor.push(options); }
    models = {
      embedContent: async (req: Record<string, any>) => {
        hoisted.genai.embed.push(structuredClone(req)); hoisted.events.push('embedding');
        return { embeddings: [{ values: vector() }] };
      },
      generateContent: async (req: Record<string, any>) => {
        hoisted.genai.generate.push(structuredClone(req)); hoisted.events.push('search');
        const next = hoisted.genai.script.shift();
        if (next instanceof Error) throw next;
        return structuredClone(next ?? geminiResponse());
      },
    };
  }
  return { GoogleGenAI, default: GoogleGenAI };
});

export const ids = {
  debate: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd5',
  lease: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5',
  fact: 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f5',
  claim: 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c5',
  utterance: 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a5',
  candidate: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
  other: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5',
  reused: 'abababab-abab-4aba-8aba-abababababa5',
  redo: 'acacacac-acac-4aca-8aca-acacacacaca5',
};

export const SECRET = 'FCKEY-gate-secret-123456';
export const config = {
  VERTEX_PROJECT_ID: 'fluxo-offline', VERTEX_REGION: 'global',
  FACTCHECK_MODEL: 'claude-sonnet-5-5', WEB_SEARCH_PROVIDER: 'claude', GEMINI_SEARCH_MODEL: 'gemini-gate-search',
  EMBEDDING_MODEL: 'embedding-gate-768', REUSE_SIMILARITY_THRESHOLD: '0.92', REUSE_MAX_AGE_DAYS: '30',
  GOOGLE_FACTCHECK_API_KEY: SECRET, CIVIC_DATA_BASE_URL: 'https://ofluxo.app/data/civic/2026',
};

export const debate = {
  debateId: ids.debate, isTest: true, status: 'live', startedAt: '2026-10-21T20:00:00Z',
  office: 'Presidente', electionCode: 2026, uf: 'BR', ibgeCityCode: null,
  broadcaster: 'Emissora de teste', audioSource: { kind: 'file', uri: null, objectPath: 'test/audio.wav', label: 'ensaio' },
  asrVocabulary: [],
  participants: [
    { id: ids.candidate, ballotName: 'Ana', party: 'PA', tseCandidateNumber: 11, displayOrder: 1, role: 'candidate' },
    { id: ids.other, ballotName: 'Bruno', party: 'PB', tseCandidateNumber: 22, displayOrder: 2, role: 'candidate' },
  ],
};

/** Formato real de DebateWorkItems.CheckItemsAsync (DV-002). */
export function item(overrides: { quote?: string; normalized?: string; type?: string; topic?: string; participantId?: string;
  fact?: string; redo?: unknown } = {}) {
  const quote = overrides.quote ?? 'O desemprego caiu para 5,3% no último trimestre';
  const fact = overrides.fact ?? ids.fact;
  const pid = overrides.participantId ?? ids.candidate;
  const person = debate.participants.find((p) => p.id === pid)!;
  return {
    itemId: fact, kind: 'check', factCheckId: fact, priority: 1,
    claim: { id: ids.claim, quote, normalizedText: overrides.normalized ?? `${quote}.`, type: overrides.type ?? 'number',
      topic: overrides.topic ?? 'emprego', utteranceId: ids.utterance, startSec: 10, endSec: 14 },
    participant: { id: person.id, ballotName: person.ballotName, party: person.party },
    debate: { id: ids.debate, title: 'Debate de teste', office: debate.office, uf: debate.uf, electionCode: 2026,
      ibgeCityCode: null, scheduledStartAt: '2026-10-21T20:00:00Z', isTest: true },
    redo: overrides.redo ?? null,
    participants: debate.participants.map((p) => ({ id: p.id, ballotName: p.ballotName, party: p.party, role: p.role,
      displayOrder: p.displayOrder })),
  };
}

export function input(it = item()) {
  return { debateId: ids.debate, leaseId: ids.lease, item: it, debate: structuredClone(debate) };
}

// ── respostas gravadas ──────────────────────────────────────────────────────

export const URLS = {
  lupa: 'https://lupa.uol.com.br/jornalismo/2026/10/02/desemprego-5-3',
  aosfatos: 'https://www.aosfatos.org/noticias/2026/10/desemprego-trimestre/',
  web: 'https://g1.globo.com/economia/noticia/2026/10/desemprego-pnad.ghtml',
  gemini: 'https://www.ibge.gov.br/explica/desemprego.php',
  reused: 'https://www.ibge.gov.br/estatisticas/pnad-reaproveitada.html',
};

export function factCheckToolsResponse() {
  return { claims: [{ text: 'Desemprego caiu para 5,3%', claimant: 'Ana', claimDate: '2026-10-01T00:00:00Z',
    claimReview: [
      { publisher: { name: 'Agência Lupa', site: 'lupa.uol.com.br' }, url: URLS.lupa, title: 'É exagerado dizer que o desemprego caiu para 5,3%',
        reviewDate: '2026-10-02T00:00:00Z', textualRating: 'Exagerado', languageCode: 'pt' },
      { publisher: { site: 'aosfatos.org' }, url: URLS.aosfatos, title: 'Desemprego no trimestre',
        reviewDate: '2026-10-03T00:00:00Z', textualRating: 'Impreciso', languageCode: 'pt' },
    ] }] };
}

const SIDRA_6381 = [
  { NC: 'Nível Territorial (Código)', NN: 'Nível Territorial', MC: 'Unidade de Medida (Código)', MN: 'Unidade de Medida', V: 'Valor',
    D1C: 'Brasil (Código)', D1N: 'Brasil', D2C: 'Variável (Código)', D2N: 'Variável', D3C: 'Trimestre Móvel (Código)', D3N: 'Trimestre Móvel' },
  { NC: '1', NN: 'Brasil', MC: '2', MN: '%', V: '5.6', D1C: '1', D1N: 'Brasil', D2C: '4099',
    D2N: 'Taxa de desocupação, na semana de referência, das pessoas de 14 anos ou mais de idade', D3C: '202609', D3N: 'jul-ago-set 2026' },
];
const SIDRA_5932 = [SIDRA_6381[0], { ...SIDRA_6381[1], V: '0.4', D2C: '6561', D2N: 'Taxa de variação do índice de volume trimestral',
  D3C: '202602', D3N: '2º trimestre 2026' }];
const AGREGADOS_5932 = [{ id: '6561', variavel: 'Taxa de variação do índice de volume trimestral', unidade: '%',
  resultados: [{ classificacoes: [], series: [{ localidade: { id: '1', nivel: { id: 'N1', nome: 'Brasil' }, nome: 'Brasil' },
    serie: { 202602: '0.4' } }] }] }];
const SGS: Record<string, { data: string; valor: string }[]> = {
  433: [{ data: '01/09/2026', valor: '0.82' }],
  13522: [{ data: '01/09/2026', valor: '4.58' }],
  432: [{ data: '21/10/2026', valor: '13.75' }],
};

const civicDir = path.resolve(process.cwd(), '../../ofluxo_site/public/data/civic/2026/national/br');
const civicFile = (name: string) => fs.readFileSync(path.join(civicDir, name), 'utf8');

export interface FetchCall { url: string; init?: RequestInit }
export const net = {
  calls: [] as FetchCall[],
  factcheck: (() => factCheckToolsResponse()) as () => unknown,
  fail: new Set<string>(),
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  net.calls.push({ url, init });
  const host = new URL(url).hostname;
  if (net.fail.has(host)) throw Object.assign(new Error(`fetch failed ${host}`), { code: 'ECONNRESET' });
  if (host === 'factchecktools.googleapis.com') { events.push('factcheck'); return json(net.factcheck()); }
  if (host === 'apisidra.ibge.gov.br') { events.push('official'); return json(/\/t\/5932\b/.test(url) ? SIDRA_5932 : SIDRA_6381); }
  if (host === 'servicodados.ibge.gov.br') { events.push('official'); return json(/5932/.test(url) ? AGREGADOS_5932 : []); }
  if (host === 'api.bcb.gov.br') {
    events.push('official');
    const n = url.match(/bcdata\.sgs\.(\d+)/)?.[1] ?? '';
    return SGS[n] ? json(SGS[n]) : json({ error: 'serie desconhecida' }, 404);
  }
  if (url.startsWith(config.CIVIC_DATA_BASE_URL)) {
    events.push('official');
    const file = url.split('?')[0].split('/').at(-1)!;
    if (!/\/national\/br\//i.test(url) || !['meta.json', 'candidatos.json'].includes(file)) return json({}, 404);
    return new Response(civicFile(file), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (host === 'api.portaldatransparencia.gov.br') { events.push('official'); return json({ error: 'Chave de API não informada' }, 401); }
  throw new Error(`Rede externa proibida nos gates DV005: ${host}`);
}));

export function verdict(parsed: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return { id: 'msg-verdict', type: 'message', role: 'assistant', model: config.FACTCHECK_MODEL,
    content: [{ type: 'text', text: JSON.stringify(parsed) }], parsed_output: parsed, stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 900, output_tokens: 80, cache_creation_input_tokens: 600, cache_read_input_tokens: 0 }, ...overrides };
}

export function searchResponse() {
  return { id: 'msg-search', type: 'message', role: 'assistant', model: config.FACTCHECK_MODEL, stop_reason: 'end_turn', stop_sequence: null,
    content: [
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'desemprego trimestre PNAD' } },
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [
        { type: 'web_search_result', url: URLS.web, title: 'Desemprego fica em 5,6% no trimestre', encrypted_content: 'enc', page_age: 'October 2026' }] },
      { type: 'text', text: 'Segundo o IBGE, a taxa ficou em 5,6%.', citations: [
        { type: 'web_search_result_location', url: URLS.web, title: 'Desemprego fica em 5,6% no trimestre',
          cited_text: 'A taxa de desocupação ficou em 5,6% no trimestre encerrado em setembro', encrypted_index: 'idx' }] },
    ],
    usage: { input_tokens: 300, output_tokens: 60, server_tool_use: { web_search_requests: 1 } } };
}

export function geminiResponse() {
  return { text: 'O IBGE explica a taxa de desocupação.', candidates: [{ content: { role: 'model', parts: [{ text: 'O IBGE explica.' }] },
    groundingMetadata: { webSearchQueries: ['desemprego trimestre'], groundingChunks: [{ web: { uri: URLS.gemini, title: 'ibge.gov.br' } }] } }],
    usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 20 } };
}

export function providerError(status: number, message: string) {
  return Object.assign(new Error(`${status} ${message}`), { status, error: { type: 'invalid_request_error', message } });
}

/** Todo token do texto variável (o modelo falso "cita" qualquer id que o worker numerou no prompt) + um id inventado. */
export function everyToken(request: Record<string, any>) {
  const text = JSON.stringify(request.messages ?? []);
  const raw = text.split(/[\s,;()[\]{}"'`<>|\\]+/).filter(Boolean);
  const out = new Set<string>(['fonte-inventada-999']);
  for (const t of raw) { out.add(t); out.add(t.replace(/^[#:=*-]+|[.:=*-]+$/g, '')); }
  out.delete('');
  return [...out];
}

export type VerdictScript = (request: Record<string, any>, n: number) => unknown;
export const allSources: VerdictScript = (request) => verdict({ verdict: 'exaggerated',
  explanation: 'A taxa oficial mais recente é 5,6%, acima do número citado.', normalizedClaim: 'O desemprego caiu para 5,3%.',
  sourceIds: everyToken(request), confidence: 0.8 });

export const isSearch = (r: Record<string, any>) => Array.isArray(r.tools) && r.tools.some((t: any) => /^web_search/.test(String(t?.type)));
export const requestText = (r: Record<string, any>) => JSON.stringify({ system: r.system, messages: r.messages });

export function harness(options: { verdicts?: (VerdictScript | unknown)[]; searches?: unknown[]; config?: Record<string, string | undefined>;
  reuse?: unknown; draftError?: Error } = {}) {
  const requests: Record<string, any>[] = [];
  const writes: { route: string; body: Record<string, any>; key?: string }[] = [];
  const verdicts = [...(options.verdicts ?? [allSources])];
  const searches = [...(options.searches ?? [searchResponse()])];
  let verdictNo = 0;
  const call = async (request: Record<string, any>) => {
    requests.push(structuredClone(request));
    if (isSearch(request)) {
      events.push('search');
      const next = searches.length > 1 ? searches.shift() : searches[0];
      if (next instanceof Error) throw next;
      if (!next) throw new Error('busca não prevista pela fixture');
      return structuredClone(next);
    }
    events.push('verdict');
    const n = verdictNo++;
    const step = verdicts.length > 1 ? verdicts.shift() : verdicts[0];
    if (step instanceof Error) throw step;
    const value = typeof step === 'function' ? (step as VerdictScript)(request, n) : step;
    if (!value) throw new Error('veredito não previsto pela fixture');
    return structuredClone(value);
  };
  const client = { messages: { parse: vi.fn(call), create: vi.fn(call) } };
  let runNo = 0;
  const api = { post: vi.fn(async (route: string, body: Record<string, any>, key?: string) => {
    writes.push({ route, body: structuredClone(body), key });
    if (route.endsWith('/ai-runs')) { runNo++; return { aiRunId: `adadadad-adad-4ada-8ada-${String(runNo).padStart(12, '0')}` }; }
    if (/\/internal\/claims\/[^/]+\/reuse-search$/.test(route)) {
      events.push('reuse-search');
      if (options.reuse instanceof Error) throw options.reuse;
      return structuredClone(options.reuse ?? { candidates: [] });
    }
    if (/\/internal\/fact-checks\/[^/]+\/ai-draft$/.test(route)) {
      events.push('ai-draft');
      if (options.draftError) throw options.draftError;
      return { revisionId: '99999999-9999-4999-8999-999999999999', revisionNo: 1, state: 'ai_public', isPublic: true };
    }
    throw new Error(`Rota inesperada: ${route}`);
  }) };
  const pipeline = createCheckPipeline({ client, api, config: { ...config, ...options.config } as never,
    now: (() => { let t = 1_000; return () => (t += 5); })(), sleep: async () => undefined } as never);
  return { pipeline, client, api, requests, writes,
    verdictRequests: () => requests.filter((r) => !isSearch(r)),
    searchRequests: () => requests.filter(isSearch),
    runs: () => writes.filter((w) => w.route.endsWith('/ai-runs')),
    drafts: () => writes.filter((w) => w.route.endsWith('/ai-draft')),
    reuseCalls: () => writes.filter((w) => w.route.endsWith('/reuse-search')) };
}

export function reset() {
  events.length = 0; net.calls.length = 0; net.fail.clear(); net.factcheck = () => factCheckToolsResponse();
  genai.embed.length = 0; genai.generate.length = 0; genai.script.length = 0;
}

export const DRAFT_KEYS = ['leaseId', 'itemId', 'aiRunId', 'promptVersion', 'verdict', 'explanation', 'normalizedClaim', 'sources',
  'confidence', 'reusedFromFactCheckId', 'searchProvider', 'redoRequestId'];
export const SOURCE_KINDS = ['fact_check', 'official_data', 'web', 'reused'];
