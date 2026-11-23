// Gates FC-011 — recorte territorial (autocomplete UF/município) e ficha de fatos do Pulso.
// ANTES da implementação cada gate DEVE falhar.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-11-14-fluxo-creator FC-011 --baseline
// .NET exige o SDK e FLUXO_TEST_POSTGRES; Vitest roda no ofluxo_site (templates em quality/test/delivery/fc-web/).
// Divergência registrada da spec: a consulta de exemplo "olho dagua" não casa pela regra "início de palavra do nome
// normalizado" (o apóstrofo vira espaço: "olho d agua das flores"). O gate usa "olho d agua" e "d'agua".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { APPSETTINGS, CREATOR_DIR, ROOT, exists, keyPaths, leaves, read, runDotnetGate, runWebVitest, stripComments, walk } from './fc-gate-helper.mjs';

// Gates compartilham classes xUnit: cada um roda só os métodos que nomeia.
const gate = (classes, options = {}) => runDotnetGate(classes, { byMethod: true, ...options });

const GEO_GZ = `${CREATOR_DIR}/Data/geo-br.json.gz`;
const BUILDER = 'backend/tools/creator-geo/build-geo.mjs';
const DOMAIN = 'ofluxo_site/src/platform/domain';
const API_CLASS = 'GateFc011GeoApiTests';
const only = (...methods) => ({ [API_CLASS]: methods });

function loadGeo(buffer) {
  return JSON.parse(zlib.gunzipSync(buffer).toString('utf8'));
}

const FORBIDDEN_KEY = /lula|bolsonaro|leader|aptos|zone|zona|section|secao|local|cpf|cnpj|email|candidate/i;

test('FC-011 geo-dataset: geo-br.json.gz embarcado, só com campos da lista branca, e regerado idêntico', () => {
  assert.ok(exists(GEO_GZ), `dataset ausente: ${GEO_GZ}`);
  assert.ok(exists(BUILDER), `gerador ausente: ${BUILDER}`);
  const csproj = read('backend/src/Fluxo.Api/Fluxo.Api.csproj');
  assert.match(csproj, /EmbeddedResource\s+Include="Modules\/Creator\/Data\/geo-br\.json\.gz"\s+LogicalName="Fluxo\.Api\.Creator\.geo-br\.json\.gz"/, 'csproj sem o EmbeddedResource do dataset');

  const bytes = fs.readFileSync(path.join(ROOT, GEO_GZ));
  assert.equal(bytes.readUInt32LE(4), 0, 'gzip com timestamp (não determinístico)');
  const geo = loadGeo(bytes);
  assert.deepEqual(Object.keys(geo).sort(), ['municipalities', 'source', 'ufs', 'version']);
  assert.deepEqual(Object.keys(geo.source).sort(), ['derivedFrom', 'generatedAt', 'name', 'publisher']);
  assert.equal(geo.ufs.length, 27);
  assert.ok(geo.ufs.some((u) => u.uf === 'DF'), 'DF ausente');
  assert.ok(!geo.ufs.some((u) => u.uf === 'ZZ'), 'exterior (ZZ) não entra');
  assert.deepEqual(geo.ufs.find((u) => u.uf === 'MG'), { code: '31', uf: 'MG', name: 'Minas Gerais' });
  for (const u of geo.ufs) assert.deepEqual(Object.keys(u).sort(), ['code', 'name', 'uf']);
  assert.equal(geo.municipalities.length, 5571);
  assert.equal(geo.municipalities.filter((m) => m.uf === 'DF').length, 1);
  assert.equal(geo.municipalities.filter((m) => m.uf === 'MG').length, 853);
  assert.deepEqual(geo.municipalities.find((m) => m.ibge === '3122306'),
    { ibge: '3122306', uf: 'MG', name: 'Divinópolis', key: 'divinopolis', porte: { id: 'ate500', label: 'de 100 a 500 mil hab.' } });
  const byIbge = new Map(geo.municipalities.map((m) => [m.ibge, m]));
  assert.equal(geo.municipalities.find((m) => m.name === "Olho d'Água das Flores")?.key, 'olho d agua das flores');
  assert.ok(geo.municipalities.some((m) => m.name === 'Xique-Xique' && m.key === 'xique xique'));
  assert.ok(geo.municipalities.some((m) => m.name === "São João d'Aliança"));
  for (const m of geo.municipalities) {
    assert.deepEqual(Object.keys(m).sort(), ['ibge', 'key', 'name', 'porte', 'uf'], `campos fora da lista branca em ${m.ibge}`);
    assert.match(m.ibge, /^\d{7}$/);
    assert.ok(m.porte === null || (Object.keys(m.porte).sort().join() === 'id,label'), `porte inválido em ${m.ibge}`);
  }
  assert.equal(byIbge.size, 5571, 'ibge repetido');
  const sorted = [...geo.municipalities].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.ibge < b.ibge ? -1 : 1));
  assert.deepEqual(geo.municipalities.map((m) => m.ibge), sorted.map((m) => m.ibge), 'ordem deve ser (key, ibge)');
  assert.deepEqual(keyPaths(geo).filter((k) => FORBIDDEN_KEY.test(k.split('.').at(-1))), [], 'chave proibida no dataset');
  const raw = zlib.gunzipSync(bytes).toString('utf8');
  assert.doesNotMatch(raw, /"(?:lula|bolsonaro|leaderName|leaderNumber|aptos|zones|places|sections)"/);

  // Regerar com o gerador (grava no caminho de saída padrão) tem de dar o mesmo JSON; o arquivo é restaurado depois.
  const before = fs.readFileSync(path.join(ROOT, GEO_GZ));
  try {
    const r = spawnSync('node', [BUILDER], { cwd: ROOT, encoding: 'utf8', timeout: 100_000 });
    assert.equal(r.status, 0, `build-geo.mjs falhou:\n${r.stderr}`);
    assert.deepEqual(loadGeo(fs.readFileSync(path.join(ROOT, GEO_GZ))), geo, 'regerar não reproduz o dataset commitado');
    assert.ok(Buffer.compare(fs.readFileSync(path.join(ROOT, GEO_GZ)), before) === 0, 'gzip regerado difere byte a byte (não determinístico)');
  } finally {
    fs.writeFileSync(path.join(ROOT, GEO_GZ), before);
  }
});

test('FC-011 geo-busca: prefixo de palavra, sem acento e sem diferença de maiúsculas, UFs por nome ou sigla', () => {
  gate(only('Search_matches_word_prefix_without_accents_or_case', 'Search_handles_apostrophe_hyphen_and_title_case', 'Ufs_are_matched_by_name_or_initials_and_never_paginate'),
    { requiredFiles: [`${CREATOR_DIR}/Application/CreatorGeoSearch.cs`, `${CREATOR_DIR}/Application/CreatorGeoCatalog.cs`], postgres: true });
});

test('FC-011 geo-paginacao: 15 em 15 por cursor opaco, 853 itens em MG, limites e erros 422', () => {
  gate(only('Cursor_walk_over_a_state_has_no_repeat_and_no_skip', 'Cursor_is_opaque_keyset_over_key_and_ibge_of_the_last_item',
    'Limit_above_page_size_is_rejected_and_not_truncated', 'Tampered_or_foreign_cursor_is_rejected', 'State_is_required_valid_and_the_query_has_a_ceiling'),
  { requiredFiles: [`${CREATOR_DIR}/Application/CreatorGeoSearch.cs`], postgres: true });
});

test('FC-011 geo-api: autenticada, 404 desligada, Cache-Control public com ETag forte e 304, sem campo sensível', () => {
  gate(only('Anonymous_gets_401_and_disabled_feature_gets_404', 'Success_is_public_cacheable_with_a_strong_etag_and_304_on_match',
    'Error_responses_never_carry_public_cache', 'Payload_has_no_document_identity_candidate_or_electoral_fields'),
  { requiredFiles: [`${CREATOR_DIR}/Application/CreatorGeoSearch.cs`], postgres: true });
});

test('FC-011 limites-config: limites novos só em CreatorOptions e appsettings, expostos em /config e validados na subida', () => {
  const files = walk(CREATOR_DIR, (f) => f.endsWith('.cs') && !f.endsWith('/CreatorOptions.cs'));
  assert.ok(files.some((f) => f.endsWith('/CreatorGeoSearch.cs')), 'CreatorGeoSearch.cs ausente');
  const offenders = files.filter((f) => /\b(86400|15)\b/.test(stripComments(read(f))));
  assert.deepEqual(offenders, [], 'literal 15 ou 86400 fora de CreatorOptions.cs');
  const geoOffenders = files.filter((f) => /CreatorGeo/.test(f) && /\b60\b/.test(stripComments(read(f))));
  assert.deepEqual(geoOffenders, [], 'literal 60 (geoQueryMaxChars) fora de CreatorOptions.cs');
  const creator = JSON.parse(read(APPSETTINGS)).Creator ?? {};
  const flat = keyPaths(creator);
  for (const key of ['GeoQueryMaxChars', 'GeoCacheSeconds', 'IndicatorsPerSingle', 'IndicatorsPerSlide', 'IndicatorsPerCarousel', 'GeoPageSize', 'GeoDebounceMs']) {
    assert.ok(flat.some((k) => k.split('.').at(-1) === key), `appsettings Creator sem ${key}`);
  }
  for (const value of [15, 250, 60, 86400, 3, 2, 8]) assert.ok(leaves(creator).includes(value), `appsettings Creator sem o valor ${value}`);
  assert.match(read(`${CREATOR_DIR}/CreatorOptions.cs`), /GeoPageSize/, 'GeoPageSize some do CreatorOptions');
  gate({
    ...only('Config_exposes_geo_and_indicator_limits_from_configuration', 'Invalid_geo_or_indicator_ranges_stop_the_startup'),
    GateFc001ApiTests: ['Payload_carries_every_limit_viewport_and_enum_from_the_spec', 'Response_never_exposes_document_or_email_fields'],
  }, { requiredFiles: [`${CREATOR_DIR}/CreatorModule.cs`], postgres: true });
});

test('FC-011 rate-limit: política creator-geo (token bucket 8/s, rajada 16) só nas rotas geo; o resto segue em api-per-user', () => {
  const geo = JSON.parse(read(APPSETTINGS)).RateLimiting?.Creator?.Geo;
  assert.deepEqual(geo, { TokensPerSecond: 8, BurstTokens: 16, QueueLimit: 0 }, 'appsettings RateLimiting:Creator:Geo');
  assert.match(read('backend/src/Fluxo.Api/Infrastructure/Traffic/ApiTrafficControlExtensions.cs'), /CreatorGeoPolicyName/, 'política creator-geo ausente');
  gate(only('Creator_geo_bucket_allows_the_burst_then_answers_429', 'Other_routes_stay_under_the_per_user_policy_while_geo_has_its_own_bucket'),
    { requiredFiles: [`${CREATOR_DIR}/Application/CreatorGeoSearch.cs`], postgres: true });
});

test('FC-011 ficha-fatos: contas do Pulso, falta de dado nunca é zero, sem n/d/breaks, determinística', () => {
  assert.ok(exists(`${DOMAIN}/creator-fact-sheet.ts`), 'creator-fact-sheet.ts ausente');
  runWebVitest({ 'gate-fc011-fact-sheet.test.ts': 'src/platform/domain/gate-fc011-fact-sheet.test.ts' }, 14);
});

test('FC-011 filtros: demográfico, eleitoral fechado (flag, offline, parecer), busca sem acento e cobertura', () => {
  assert.ok(exists(`${DOMAIN}/creator-pulso-catalog.ts`), 'creator-pulso-catalog.ts ausente');
  runWebVitest({ 'gate-fc011-pulso-catalog.test.ts': 'src/platform/domain/gate-fc011-pulso-catalog.test.ts' }, 9);
});

test('FC-011 cliente-web: schemas zod, normalizeGeoQuery igual ao backend e cliente que lê os limites da config', () => {
  assert.ok(exists(`${DOMAIN}/creator-geo.ts`) && exists('ofluxo_site/src/platform/infrastructure/creator-geo-api.ts'), 'creator-geo.ts ou creator-geo-api.ts ausente');
  runWebVitest({ 'gate-fc011-geo-client.test.ts': 'src/platform/domain/gate-fc011-geo-client.test.ts' }, 5);
});

// Gate corrigido (decisão D): a varredura antiga `\bcandidat\w*\b` pegava o identificador genérico em inglês `candidate`
// (variável local em CreatorAccessPolicy.cs e CreatorContrast.cs), sem relação com candidato eleitoral. Continua barrando DADO de
// candidato: termos em português (candidato/candidata/candidatos), lula, bolsonaro, leaderName/leaderNumber; e o inglês
// quando é campo, chave ou tipo (PascalCase `Candidate...`, composto `candidateName`, chave "candidate", `.candidate`, `candidate:`).
// Fica livre só `candidate` minúsculo, solto, como variável local.
// FC-014 (parecer APROVADO, parecer-juridico-eleitoral.md): (1) `aptos` saiu da lista — eleitorado apto é dado
// público administrativo e agora é INDICADOR explícito do contexto eleitoral (sem direção de voto); (2) `candidato A`
// / `candidato B` seguidos de letra é o RÓTULO NEUTRO obrigatório da peça eleitoral — qualquer outro uso de candidato
// segue barrado. Anonimato e lista branca do dataset eleitoral são provados pelo gate FC-014.
const CANDIDATE_DATA = [
  /\b(?:lula|bolsonaro|leaderName|leaderNumber)\b/i,
  /\bcandidat(?:o|a|os|as)\b(?!\s+[AB]\b)/i,
  /\bCandidate\w*/,
  /\bcandidate[A-Z_]\w*/,
  /["'`]candidate\w*["'`]/i,
  /\.candidate\w*/i,
  /\bcandidate\w*\s*:(?!:)/,
];
export const hasCandidateData = (code) => CANDIDATE_DATA.some((re) => re.test(code));

test('FC-011 privacidade: negativo, o varredor ainda pega dado de candidato e deixa passar a variável local `candidate`', () => {
  const mustCatch = [
    'public string Candidato { get; init; }', 'var candidata = x;', 'row.leaderName', 'const k = "leaderNumber";',
    'record Dto(string LeaderName)', 'var lula = 1;', 'x.Bolsonaro', 'public int CandidateVotes { get; }',
    'var candidateName = row.name;', 'json["candidate"]', 'obj.candidate', '{ candidate: 1 }', 'colunas: candidatos',
  ];
  for (const sample of mustCatch) assert.equal(hasCandidateData(sample), true, `deveria pegar: ${sample}`);
  const mustAllow = [
    'foreach (var candidate in Enum.GetValues<CreatorMemberRole>())', 'if (string.Equals(candidate.ToString(), name)) parsed = candidate;',
    'var candidate = FromHsl(h, s, next);', 'if (Ratio(candidate, background) >= limits.GoodMin) return candidate;',
  ];
  for (const sample of mustAllow) assert.equal(hasCandidateData(sample), false, `não deveria pegar: ${sample}`);
});

test('FC-011 privacidade: sem CPF/CNPJ literal, sem colunas de candidato e sem seção, zona ou local de votação', () => {
  const targets = [
    ...walk(CREATOR_DIR, (f) => f.endsWith('.cs')),
    `${DOMAIN}/creator-fact-sheet.ts`, `${DOMAIN}/creator-pulso-catalog.ts`, `${DOMAIN}/creator-geo.ts`,
    'ofluxo_site/src/platform/infrastructure/creator-geo-api.ts', BUILDER,
  ];
  for (const must of ['CreatorGeoSearch.cs', 'creator-fact-sheet.ts', 'creator-pulso-catalog.ts', 'creator-geo.ts', 'creator-geo-api.ts', 'build-geo.mjs']) {
    assert.ok(targets.some((t) => t.endsWith(must) && exists(t)), `arquivo novo ausente: ${must}`);
  }
  const offenders = [];
  for (const file of targets.filter(exists)) {
    const code = stripComments(read(file));
    if (/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b|\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b|\b\d{11}\b|\b\d{14}\b/.test(code)) offenders.push(`${file}: CPF/CNPJ literal`);
    if (hasCandidateData(code)) offenders.push(`${file}: coluna de candidato`);
    if (/\b(secao|secoes|zona|zonas|votingPlace|locais)\b/i.test(code)) offenders.push(`${file}: seção, zona ou local de votação`);
  }
  assert.deepEqual(offenders, []);
  assert.ok(exists(GEO_GZ), 'dataset ausente');
  assert.doesNotMatch(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, GEO_GZ))).toString('utf8'), /"(?:secao|section|zona|zone|local|votingPlace)\w*"/i);
});

test('FC-011 sem-secao-eleitoral: /geo/secoes não existe (404), com ou sem a flag eleitoral', () => {
  gate(only('Section_route_is_not_mapped_even_with_the_electoral_flag'),
    { requiredFiles: [`${CREATOR_DIR}/Application/CreatorGeoSearch.cs`], postgres: true });
});

test('FC-011 fronteira: rotas geo fora de AnonymousPaths e no Theory de fronteira anônima', () => {
  const anonymous = JSON.parse(read(APPSETTINGS)).Firebase?.AnonymousPaths ?? [];
  assert.ok(anonymous.length > 0, 'AnonymousPaths ausente: o gate não leria a lista real');
  assert.deepEqual(anonymous.filter((p) => p.includes('creator')), [], 'rota do Creator não pode ser anônima');
  const boundary = read('backend/tests/Fluxo.Api.Tests/ApiBoundaryTests.cs');
  assert.match(boundary, /InlineData\("\/api\/v1\/creator\/geo\/ufs[^"]*"\)/, 'ApiBoundaryTests sem /geo/ufs no Theory');
  assert.match(boundary, /InlineData\("\/api\/v1\/creator\/geo\/municipios[^"]*"\)/, 'ApiBoundaryTests sem /geo/municipios no Theory');
  gate({}, { existing: ['ApiBoundaryTests.Every_module_denies_anonymous_requests'], requiredFiles: [`${CREATOR_DIR}/Application/CreatorGeoSearch.cs`] });
});
