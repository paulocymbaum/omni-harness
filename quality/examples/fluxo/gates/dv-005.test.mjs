// Gates DV-005: checagem no worker (Fact Check Tools, dados oficiais, busca, veredito Sonnet, pgvector via API),
// rascunho publicado na hora como balão (ai-draft) e pendências herdadas da DV-004.
// As partes .NET de ai-draft/reuse-search/visibilidade já existem (DV-002); estes gates cobrem só o que a DV-005 acrescenta.
// Tudo offline: Vertex, Gemini, Fact Check Tools, IBGE, BCB e civic são falsos (dv-005-vitest/support.ts).
// O gate .NET exige FLUXO_TEST_POSTGRES (PostgreSQL descartável com pgvector).
// ANTES da implementação todos DEVEM falhar:
//   node quality/delivery/eval.mjs docs/entregas/2026-10-21-debate-ao-vivo DV-005 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, WORKER } from './dv-worker-gate-helper.mjs';
import { runCheckSpec, runDotnetTemplate } from './dv-005-gate-helper.mjs';

test('DV-005 check-dispatch: lease-loop despacha check (até 4 em paralelo) e o laço pede extract e check', () => {
  runCheckSpec('check-dispatch.vitest.ts', [
    'despacha itens check ao checker com até 4 em paralelo',
    'item check inválido é ignorado e lease vazio não chama o checker',
    'lease vencido para de iniciar novos itens',
    'laço de produção pede extract e check e despacha cada lote pelo kind',
  ]);
});

test('DV-005 factcheck-tools: claims:search com languageCode=pt, mapeamento, chave fora dos logs, falha não fatal', () => {
  runCheckSpec('factcheck-tools.vitest.ts', [
    'consulta claims:search com query normalizada, languageCode=pt, pageSize=10 e chave',
    'mapeia claimReview para fontes fact_check com veículo, data e selo',
    'chave nunca aparece em log nem em corpo enviado à API',
    'cada consulta gera ai-run factcheck_lookup sem tokens',
    'erro, HTTP 500 ou resposta vazia não interrompem o pipeline',
  ]);
});

test('DV-005 reuse-pgvector: embedding 768 → reuse-search; atalho só com mesmo participante, limiar e idade, sempre balão', () => {
  runCheckSpec('reuse.vitest.ts', [
    'calcula embedding de 768 dimensões com EMBEDDING_MODEL e chama reuse-search da afirmação',
    'atalho: mesmo participante, limiar e idade reaproveitam sem Sonnet e continuam balão',
    'outro participante, similaridade abaixo do limiar ou validação antiga vão ao Sonnet como fonte reused',
    'falha do reuse-search não derruba o item',
  ]);
});

test('DV-005 official-routers: SIDRA, SGS e TSE civic por fixture; só type number; Transparência desligada sem chave', () => {
  runCheckSpec('official.vitest.ts', [
    'desemprego consulta SIDRA 6381/4099 e vira fonte IBGE com o valor no prompt',
    'PIB consulta a tabela 5932 do IBGE',
    'IPCA e Selic consultam BCB SGS 433/13522 e 432',
    'abstenção do 1º turno vem do civic publicado, com cache por processo',
    'roteamento só para type number e Portal da Transparência desligado sem chave',
    'worker não lê BigQuery',
  ]);
});

test('DV-005 search-fallback: busca básica do Claude separada do veredito, fallback Gemini e modo none', () => {
  runCheckSpec('search.vitest.ts', [
    'claude: busca básica web_search_20250305 em chamada separada, sem output_config',
    'claude: citações web_search_result_location viram fontes web e ai-run search',
    'erro permanente de ferramenta indisponível troca para Gemini até reiniciar',
    'gemini configurado usa grounding e não chama a busca do Claude',
    'none pula a busca e mantém o veredito',
  ]);
});

test('DV-005 verdict-sonnet: structured output com cache, fontes só da lista, no_data, 280 caracteres, refusal, redo', () => {
  runCheckSpec('verdict.vitest.ts', [
    'veredito usa FACTCHECK_MODEL, structured output e cache_control no fim do system estável',
    'remove sourceIds inventados e publica só fontes da lista enviada',
    'sem fonte válida o veredito vira no_data',
    'normaliza caixa do enum e limita confidence a [0, 1]',
    'explicação acima de 280 tenta de novo e, persistindo, corta na última frase completa',
    'refusal não envia ai-draft e registra ai-run verdict com status',
    'redo leva a instrução do checador ao prompt e o requestId ao ai-draft',
    'ai-run verdict antecede o ai-draft e carrega promptVersion e aiRunId',
  ]);
});

test('DV-005 ai-draft-balloon: camadas em ordem e rascunho publicado na hora por um único ai-draft, sem ação humana', () => {
  runCheckSpec('ai-draft.vitest.ts', [
    'ordem das camadas: reaproveitamento, dados oficiais, busca, veredito e ai-draft',
    'publica o rascunho na hora: um único ai-draft com corpo e Idempotency-Key do contrato',
    'ai-run por chamada: embedding, factcheck_lookup, search e verdict antes do ai-draft',
    'falha de camadas anteriores não derruba o item',
    '409 lease_expired no ai-draft não repete o envio e devolve lease_expired',
    '409 de checagem fechada ou validada não repete o envio',
  ]);
});

test('DV-005 ingest-work-loop: a ingestão roda o lease-loop (extração e checagem) no mesmo processo; work continua', () => {
  runCheckSpec('ingest-work.vitest.ts', [
    'ingestão roda o laço de trabalho com extração e checagem e o encerra junto',
    'comando work continua disponível e também leva o checker',
  ]);
});

// ── pendências herdadas: enums e persistência aditiva ───────────────────────

const DISCARD = ['not_checkable', 'opinion', 'vague_promise', 'attack_without_fact', 'extraction_error', 'duplicate', 'other'];
const snake = (n) => n.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

test('DV-005 discard-reasons: DiscardReasonCode com 7 valores no backend e espelhos; wire do worker sem none/not_verifiable', async () => {
  const cs = fs.readFileSync(path.join(ROOT, 'backend/src/Fluxo.Api/Modules/Debates/DebateEnums.cs'), 'utf8');
  const members = cs.match(/enum\s+DiscardReasonCode\s*\{([^}]*)\}/)?.[1].split(',').map((s) => snake(s.trim())).filter(Boolean);
  assert.deepEqual([...(members ?? [])].sort(), [...DISCARD].sort(), 'DiscardReasonCode no DebateEnums.cs');
  for (const rel of ['services/debate-worker/src/domain/debate-enums.ts', 'admin-web/src/modules/debates/domain/enums.ts']) {
    const ts = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const decl = ts.match(/\bDiscardReasonCode\b[\s\S]*?(?:;|\n\n)/)?.[0];
    assert.ok(decl, `DiscardReasonCode não declarado em ${rel}`);
    const literals = [...new Set([...decl.matchAll(/['"]([a-z_]+)['"]/g)].map((m) => m[1]))].sort();
    assert.deepEqual(literals, [...DISCARD].sort(), `espelho DiscardReasonCode em ${rel}`);
  }
  const regras = await import(pathToFileURL(path.join(ROOT, '.claude/hooks/lib/regras.mjs')).href);
  assert.ok((regras.CANONICAL_ENUMS.DiscardReasonCode ?? []).includes('services/debate-worker/src/domain/debate-enums.ts'));
  runCheckSpec('discard-wire.vitest.ts', ['wire usa DiscardReasonCode: not_verifiable vira not_checkable e none deixa de existir']);
});

// Hashes das migrations e SQL do DV-002 em 2026-10-21 (commit eb3b755a): nenhuma pode mudar.
const FROZEN = {
  'backend/src/Fluxo.Api/Infrastructure/Persistence/Migrations/20261021204639_DebatesMvp.Designer.cs': '680b71bef65f63fee7290912a611c287346d92f00eedd829a7eb95b60c7dcbb5',
  'backend/src/Fluxo.Api/Infrastructure/Persistence/Migrations/20261021204639_DebatesMvp.Locks.cs': '5504fe9babb942fb7e342770d9d8f27f4ae3393b94c03aa3196f6ea6dac7714e',
  'backend/src/Fluxo.Api/Infrastructure/Persistence/Migrations/20261021204639_DebatesMvp.cs': '8a3c0c8003ed61dde04fd1616c6fcda7919aea6762d7c67b2fa924d7cfcb7267',
  'backend/src/Fluxo.Api/Infrastructure/Persistence/Migrations/20261021204740_DebatesPgvector.Designer.cs': '9996c95678c06d9b2b82fb8ae56dad87a42e2c2ad78b28a57ad8a47c97059c4e',
  'backend/src/Fluxo.Api/Infrastructure/Persistence/Migrations/20261021204740_DebatesPgvector.cs': 'ff9fd4573788df2cb767f39b9adb4e181ff9ef8c04ef3ecb35879a5b984fb663',
  'backend/deploy/sql/debates-mvp.sql': '7cf026d67a6fe50c7d1f3848f589b2a73a0d5580f549984261fd4b965293b03c',
  'backend/deploy/sql/debates-pgvector.sql': '84b057365212ec6f72188b29ba9c6b914b9e3a466028499ae12e0c6f22cf2e2d',
};

test('DV-005 additive-persistence: migration nova (EF + SQL do migrator) sem alterar as existentes; ai-run, claim e pergunta gravam os campos', () => {
  for (const [rel, sha] of Object.entries(FROZEN)) {
    const actual = createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');
    assert.equal(actual, sha, `${rel} foi alterado: a DV-005 só pode adicionar migration nova`);
  }
  const migDir = path.join(ROOT, 'backend/src/Fluxo.Api/Infrastructure/Persistence/Migrations');
  const added = fs.readdirSync(migDir).filter((f) => /^\d{14}_\w+\.cs$/.test(f) && !f.endsWith('.Designer.cs')
    && f.slice(0, 14) > '20261021204740');
  assert.ok(added.length >= 1, 'nenhuma migration EF nova depois de DebatesPgvector');
  const entry = fs.readFileSync(path.join(ROOT, 'backend/deploy/migrator/entrypoint.sh'), 'utf8');
  const applied = [...entry.matchAll(/\$\{SQL_DIR\}\/([\w.-]+\.sql)/g)].map((m) => m[1]);
  const after = applied.slice(applied.indexOf('debates-pgvector.sql') + 1, applied.indexOf('grant-runtime.sql'));
  assert.ok(after.length >= 1, 'entrypoint.sh precisa aplicar um SQL novo entre debates-pgvector.sql e grant-runtime.sql');
  for (const f of after) assert.ok(fs.existsSync(path.join(ROOT, 'backend/deploy/sql', f)), `SQL ausente: backend/deploy/sql/${f}`);
  runDotnetTemplate('DebateDv005GateTests.cs', 'DebateDv005GateTests', [
    'Ai_run_persists_provider_region_cache_creation_invalid_items_and_subject',
    'Ai_run_accepts_check_kinds_including_factcheck_lookup',
    'Extraction_persists_priority_discard_reason_and_question_topic',
    'Discard_reason_code_wire_and_sql_check_are_aligned',
  ]);
});

test('DV-005 env-example: variáveis novas de checagem documentadas e @google/genai como dependência', () => {
  const env = fs.readFileSync(path.join(WORKER, '.env.example'), 'utf8');
  for (const key of ['FACTCHECK_MODEL', 'WEB_SEARCH_PROVIDER', 'GEMINI_SEARCH_MODEL', 'EMBEDDING_MODEL', 'REUSE_SIMILARITY_THRESHOLD',
    'REUSE_MAX_AGE_DAYS', 'PORTAL_TRANSPARENCIA_API_KEY', 'CIVIC_DATA_BASE_URL', 'GOOGLE_FACTCHECK_API_KEY']) {
    assert.match(env, new RegExp(`^${key}=`, 'm'), `.env.example precisa declarar ${key}`);
  }
  assert.match(env, /^WEB_SEARCH_PROVIDER=claude$/m);
  assert.match(env, /^REUSE_SIMILARITY_THRESHOLD=0\.92$/m);
  assert.match(env, /^REUSE_MAX_AGE_DAYS=30$/m);
  assert.match(env, /^CIVIC_DATA_BASE_URL=https:\/\/ofluxo\.app\/data\/civic\/2026$/m);
  const pkg = JSON.parse(fs.readFileSync(path.join(WORKER, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies?.['@google/genai'], '@google/genai precisa ser dependência de produção');
  for (const forbidden of ['pg', 'postgres', 'npgsql', '@google-cloud/bigquery']) {
    assert.equal(pkg.dependencies?.[forbidden], undefined, `${forbidden} proibido no worker`);
  }
});
