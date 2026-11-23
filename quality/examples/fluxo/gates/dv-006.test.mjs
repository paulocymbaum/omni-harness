// Gates DV-006 — admin-web: módulo debates (fonte do áudio, ingestão, importação de candidatos, mesa com SSE).
// ANTES da implementação cada gate DEVE falhar: admin-web/src/modules/debates/ ainda não existe.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-10-21-debate-ao-vivo DV-006 --baseline
//
// Escopo: só o que o DV-006 acrescenta ao admin-web. O servidor (rotas, SSE, permissões na API) é do DV-002
// e já está done, por isso nenhum gate aqui verifica o .NET, exceto como fonte dos valores de enum.
// Specs Vitest do próprio gate ficam em quality/test/delivery/dv-006-vitest/ e são copiados para
// admin-web/src/__dv006_gate_<pid>__/ só durante a execução (ver dv-006-vitest-helper.mjs).
// Casos nomeados (runNamedCases) são escritos pelo implementador com o título exato listado aqui.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, ADMIN, runGateSpecs, runNamedCases, sourceFiles } from './dv-006-vitest-helper.mjs';

const MODULE = path.join(ADMIN, 'src/modules/debates');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

function assertFiles(rels) {
  assert.deepEqual(rels.filter((rel) => !exists(rel)), [], 'arquivos do DV-006 ausentes');
}

/** Trecho da rota `path` no AppRouter, com constantes do mesmo arquivo citadas no trecho expandidas. */
function routeSegment(src, routePath) {
  const re = new RegExp(`path:\\s*["'\`]/?${routePath.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}["'\`]`);
  const m = re.exec(src);
  assert.ok(m, `AppRouter sem a rota ${routePath}`);
  const rest = src.slice(m.index + m[0].length);
  const next = rest.search(/\bpath:\s*["'`]/);
  const segment = next >= 0 ? rest.slice(0, next) : rest;
  let expanded = segment;
  for (const id of new Set(segment.match(/\b[A-Za-z_$][\w$]*\b/g) ?? [])) {
    const decl = new RegExp(`(?:const|let)\\s+${id}\\b[^=]*=([^;]*);`).exec(src);
    if (decl) expanded += `\n${decl[1]}`;
  }
  return expanded;
}

// ── DV-006-PERMISSION-ROUTES ─────────────────────────────────────────────────

test('DV-006 permission-routes: rotas /debates, /fonte e /mesa com gate certo e telas escondem ações sem permissão', () => {
  assertFiles([
    'admin-web/src/modules/debates/presentation/DebatesPage.tsx',
    'admin-web/src/modules/debates/presentation/DebateSourcePage.tsx',
    'admin-web/src/modules/debates/presentation/DebateDeskPage.tsx',
  ]);
  const router = read('admin-web/src/app/router/AppRouter.tsx');
  for (const page of ['DebatesPage', 'DebateSourcePage', 'DebateDeskPage']) {
    assert.match(router, new RegExp(`\\b${page}\\b`), `AppRouter deve usar ${page}`);
  }
  const list = routeSegment(router, 'debates');
  const source = routeSegment(router, 'debates/:id/fonte');
  const desk = routeSegment(router, 'debates/:id/mesa');
  for (const [name, seg] of [['/debates', list], ['/debates/:id/fonte', source]]) {
    assert.match(seg, /anyOf/, `${name} deve usar PermissionGate anyOf`);
    assert.match(seg, /debates\.manage/, `${name} deve aceitar debates.manage`);
    assert.match(seg, /debates\.operate/, `${name} deve aceitar debates.operate`);
  }
  assert.match(desk, /debates\.operate/, '/debates/:id/mesa exige debates.operate');
  assert.doesNotMatch(desk, /debates\.manage/, '/debates/:id/mesa não abre só com debates.manage');

  runGateSpecs(['permission-gate.vitest.tsx']);
  runNamedCases({
    'src/modules/debates/presentation/DebatesPage.test.tsx': [
      'sem debates.manage esconde Criar, Editar e Candidatos',
      'sem debates.operate esconde o link da Mesa',
      'operador sem debates.manage vê os links de Fonte e Mesa',
    ],
    'src/modules/debates/presentation/DebateSourcePage.test.tsx': [
      'definir fonte e enviar arquivo só com debates.manage',
    ],
    'src/modules/debates/presentation/IngestionStatusCard.test.tsx': [
      'Ligar e Desligar só com debates.operate',
    ],
  });
});

// ── DV-006-INGESTION-SOURCE ──────────────────────────────────────────────────

test('DV-006 ingestion-source: upload direto ao bucket por PUT, fonte file/url/device e ingestion:start com Idempotency-Key', () => {
  assertFiles([
    'admin-web/src/modules/debates/infrastructure/audioUpload.ts',
    'admin-web/src/modules/debates/infrastructure/debatesApi.ts',
    'admin-web/src/modules/debates/presentation/IngestionStatusCard.tsx',
  ]);
  const upload = read('admin-web/src/modules/debates/infrastructure/audioUpload.ts');
  assert.match(upload, /\bXMLHttpRequest\b/, 'upload usa XMLHttpRequest (progresso)');
  assert.doesNotMatch(upload, /\bfetch\s*\(/, 'o arquivo não passa por fetch nem pela API');
  const api = read('admin-web/src/modules/debates/infrastructure/debatesApi.ts');
  for (const fn of ['requestAudioUpload', 'setAudioSource', 'startIngestion', 'stopIngestion', 'callDebatesApi']) {
    assert.match(api, new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${fn}\\b`), `debatesApi.ts deve exportar ${fn}`);
  }
  assert.match(api, /Idempotency-Key/i, 'debatesApi.ts envia Idempotency-Key');

  runNamedCases({
    'src/modules/debates/infrastructure/audioUpload.test.ts': [
      'envia o arquivo por PUT na URL assinada com os headers devolvidos e nunca ao host da API',
      'ao terminar define a fonte file com o objectPath devolvido',
      'cancelar aborta o upload e não define a fonte',
    ],
    'src/modules/debates/infrastructure/debatesApi.test.ts': [
      'setAudioSource envia url e device no formato do contrato',
      'toda escrita envia Idempotency-Key e o retry reaproveita a mesma chave',
      'Problem Details preserva o code em maiúsculas sem achatar o 409',
    ],
    'src/modules/debates/presentation/IngestionStatusCard.test.tsx': [
      'Ligar não chama startIngestion sem fonte definida',
    ],
  });
});

// ── DV-006-STREAM-RECONNECT ──────────────────────────────────────────────────

test('DV-006 stream-reconnect: fetch+ReadableStream, Last-Event-ID na reconexão, polling ?once=1, Retry-After e sem EventSource', () => {
  assertFiles(['admin-web/src/modules/debates/infrastructure/debateStream.ts']);
  const client = read('admin-web/src/shared/infrastructure/apiClient.ts');
  assert.match(client, /export\s+(?:async\s+)?(?:function|const)\s+buildApiHeaders\b|export\s*\{[^}]*\bbuildApiHeaders\b/, 'apiClient.ts exporta buildApiHeaders');
  assert.match(client, /export\s+const\s+apiBaseUrl\b|export\s*\{[^}]*\bapiBaseUrl\b/, 'apiClient.ts exporta apiBaseUrl');
  assert.doesNotMatch(client, /case\s+["'][^"']*[Dd]ebate/, 'o switch de callApiAdmin não recebe operações de debates');
  const offenders = sourceFiles(MODULE).filter((f) => /\bEventSource\s*\(/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map((f) => path.relative(ROOT, f)), [], 'a mesa não instancia EventSource');

  runGateSpecs(['stream-reconnect.vitest.ts']);
});

// ── DV-006-SSE-PARSER ────────────────────────────────────────────────────────

test('DV-006 sse-parser: pedaços cortados, \\r\\n e \\r, data multilinha, comentário, id e retry', () => {
  assertFiles(['admin-web/src/modules/debates/domain/sseParser.ts']);
  const src = read('admin-web/src/modules/debates/domain/sseParser.ts');
  assert.doesNotMatch(src, /\b(window|document|EventSource)\b/, 'parser puro, sem DOM');
  runGateSpecs(['sse-parser.vitest.ts']);
});

// ── DV-006-DESK-SHORTCUTS ────────────────────────────────────────────────────

test('DV-006 desk-shortcuts: 1–9 por displayOrder, ignora campos editáveis e modificadores, Shift corrige a fala', () => {
  assertFiles(['admin-web/src/modules/debates/domain/deskShortcuts.ts']);
  runGateSpecs(['desk-shortcuts.vitest.ts']);
});

// ── DV-006-NO-FIRESTORE ──────────────────────────────────────────────────────

test('DV-006 no-firestore: módulo debates só fala com a API .NET (sem Firestore, Functions ou callAdmin)', () => {
  const required = [
    'domain/enums.ts', 'domain/debate.ts', 'domain/debateForm.ts', 'domain/sseParser.ts', 'domain/deskState.ts',
    'domain/deskShortcuts.ts', 'infrastructure/debatesApi.ts', 'infrastructure/debateStream.ts',
    'infrastructure/audioUpload.ts', 'presentation/DebatesPage.tsx', 'presentation/DebateFormDialog.tsx',
    'presentation/ParticipantsImportDialog.tsx', 'presentation/DebateSourcePage.tsx',
    'presentation/IngestionStatusCard.tsx', 'presentation/DebateDeskPage.tsx', 'presentation/debateLabels.ts',
  ].map((f) => `admin-web/src/modules/debates/${f}`);
  assertFiles(required);
  const files = sourceFiles(MODULE);
  const rules = [
    [/["']firebase\/firestore["']/, 'firebase/firestore'],
    [/["']firebase\/functions["']/, 'firebase/functions'],
    [/["'][^"']*\/adminClient["']/, 'shared/infrastructure/adminClient'],
    [/\bcallAdmin\b/, 'callAdmin'],
    [/\bhttpsCallable\b/, 'httpsCallable'],
    [/import\s*\{[^}]*\bfunctions\b[^}]*\}\s*from\s*["'][^"']*shared\/infrastructure\/firebase["']/, 'functions de shared/infrastructure/firebase'],
  ];
  const hits = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const [re, label] of rules) if (re.test(src)) hits.push(`${path.relative(ROOT, file)}: ${label}`);
  }
  assert.deepEqual(hits, [], 'modules/debates não pode ler Firestore nem chamar Cloud Functions');
  assert.match(read('admin-web/src/modules/debates/presentation/DebatesPage.tsx'), /callDebatesApi/, 'DebatesPage usa callDebatesApi como callFn');
});

// ── DV-006-PARTICIPANT-NO-PII ────────────────────────────────────────────────

test('DV-006 participant-no-pii: schemas de participante e candidato do snapshot rejeitam cpf, titulo e birthDate', () => {
  assertFiles(['admin-web/src/modules/debates/domain/debate.ts']);
  runGateSpecs(['participant-no-pii.vitest.ts']);
});

// ── DV-006-ENUM-PARITY ───────────────────────────────────────────────────────

function csharpEnums() {
  const src = read('backend/src/Fluxo.Api/Modules/Debates/DebateEnums.cs');
  const snake = (name) => name.replace(/(?!^)([A-Z])/g, '_$1').toLowerCase();
  const out = {};
  for (const m of src.matchAll(/public\s+enum\s+(\w+)\s*\{([^}]*)\}/g)) {
    out[m[1]] = m[2].split(',').map((s) => s.trim()).filter(Boolean).map(snake);
  }
  return out;
}

test('DV-006 enum-parity: domain/enums.ts tem os mesmos valores wire de DebateEnums.cs', () => {
  const expected = csharpEnums();
  assert.deepEqual(expected.Verdict, ['true', 'false', 'inaccurate', 'exaggerated', 'no_data', 'pending'], 'leitura de DebateEnums.cs');
  assert.ok(expected.DebatePublicMode && expected.AudioSourceKind, 'DebateEnums.cs sem DebatePublicMode/AudioSourceKind');
  assertFiles(['admin-web/src/modules/debates/domain/enums.ts']);
  runGateSpecs(['enum-parity.vitest.ts'], { __EXPECTED_ENUMS__: JSON.stringify(expected) });
});
