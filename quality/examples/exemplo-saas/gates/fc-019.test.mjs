// Gates FC-019 — override de autenticação de desenvolvimento (Auth:DevOverride) e ambiente Docker local do Creator.
// ANTES da implementação cada gate DEVE falhar.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-11-14-fluxo-creator FC-019 --baseline
// .NET exige o SDK, FLUXO_TEST_POSTGRES e FIRESTORE_EMULATOR_HOST (a guarda de arranque do override exige o emulador).
// Reaproveita fc-gate-helper.mjs / fc-001-gate-helper.mjs (runDotnetGate, read, walk...) e os templates
// GateFc002Support.cs / GateFc017Support.cs; os próprios são fc-dotnet/GateFc019*.cs (formas no cabeçalho do suporte).
// Regra de ouro: NENHUM uid, e-mail ou businessId real em gate nem em teste. Só `gate-*`, `*@example.test`.
// Fora do eval (manual-pendente): subida real do docker compose com o `.env` do dono; varredura contra os
// identificadores reais só roda onde existir FLUXO_CREATOR_REAL_IDS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { APPSETTINGS, ROOT, exists, read, requireEnv, runDotnetGate, stripComments, walk } from './fc-gate-helper.mjs';

const SEC = 'backend/src/Exemplo SaaS.Api/Infrastructure/Security';
const OPTIONS_CS = `${SEC}/DevAuthOverrideOptions.cs`;
const VERIFIER_CS = `${SEC}/DevOverrideTokenVerifier.cs`;
const DI_CS = `${SEC}/FirebaseSecurityServiceCollectionExtensions.cs`;
const COMPOSE = 'backend/deploy/docker-compose.creator-local.yml';
const LOCAL = 'backend/deploy/creator-local';
const SEED = `${LOCAL}/seed-firestore.mjs`;
const LOCAL_README = `${LOCAL}/README.md`;
const SPEC = 'docs/entregas/2026-11-14-fluxo-creator/specs/FC-019.md';
const SUPPORT = ['GateFc002Support.cs', 'GateFc017Support.cs', 'GateFc019Support.cs'];

const code = (file) => stripComments(read(file));
const devFiles = () => [OPTIONS_CS, VERIFIER_CS, DI_CS, COMPOSE, SEED, `${LOCAL}/up.sh`, LOCAL_README, 'backend/README.md', SPEC];
const appsettingsFiles = () => walk('backend/src/Exemplo SaaS.Api', (f) => /(^|\/)appsettings[^/]*\.json$/.test(f));
// Gates compartilham classes xUnit: cada um roda só os métodos que nomeia.
const gate = (classes, options = {}) => runDotnetGate(classes, { byMethod: true, support: SUPPORT, postgres: true, ...options });
const noPg = (classes, options = {}) => gate(classes, { postgres: false, ...options });

const OPTIONS = 'GateFc019OptionsTests';
const VERIFIER = 'GateFc019VerifierTests';
const API = 'GateFc019ApiTests';

// ───────────────────────── padrão desligado ─────────────────────────

test('FC-019 padrao-desligado: appsettings traz Auth.DevOverride fechado e o container resolve o verificador real', () => {
  const settings = JSON.parse(read(APPSETTINGS));
  assert.deepEqual(settings.Auth, { DevOverride: { Enabled: false, AllowedUids: '' } }, 'appsettings.json precisa de Auth.DevOverride fechado');
  for (const file of appsettingsFiles()) {
    const json = JSON.parse(read(file));
    assert.equal(json.Auth?.DevOverride?.Enabled ?? false, false, `${file}: Auth.DevOverride.Enabled precisa ser false`);
    assert.equal(json.Auth?.DevOverride?.AllowedUids ?? '', '', `${file}: Auth.DevOverride.AllowedUids precisa ser vazio`);
  }
  const di = code(DI_CS);
  assert.match(di, /DevAuthOverrideOptions/, 'o bind de Auth:DevOverride precisa existir em AddFirebaseSecurity');
  assert.match(di, /ValidateOnStart/, 'a guarda de arranque precisa estar registrada');
  noPg({ [OPTIONS]: ['Default_settings_leave_the_override_off_and_the_container_resolves_the_real_verifier'] },
    { requiredFiles: [OPTIONS_CS, VERIFIER_CS, DI_CS] });
});

// ───────────────────────── recusa desligado ─────────────────────────

test('FC-019 recusa-desligado: com o override desligado, dev.<uid> e token malformado dão 401 sem eco do uid', () => {
  gate({ [API]: ['Disabled_override_rejects_dev_tokens_and_malformed_tokens_with_401_without_echoing'] },
    { requiredFiles: [VERIFIER_CS, DI_CS] });
});
// ───────────────────────── guarda de arranque ─────────────────────────

test('FC-019 arranque-ambiente: Enabled=true só sobe em Development e Testing; Cloud Run, lista vazia, uid inválido e emulador ausente derrubam a subida citando a chave', () => {
  requireEnv('FIRESTORE_EMULATOR_HOST', 'emulador do Firestore: a guarda do override o exige');
  assert.match(code(OPTIONS_CS), /Enabled=true is not allowed outside Development and Testing/, 'mensagem da guarda de ambiente');
  noPg({
    [OPTIONS]: [
      'Enabled_true_boots_in_development_and_testing_and_resolves_the_decorator',
      'Enabled_true_stops_the_startup_outside_development_and_testing',
      'Cloud_run_indicators_stop_the_startup_even_in_development',
      'Empty_list_invalid_entries_and_missing_emulator_stop_the_startup_citing_the_key_never_the_value',
      'Csv_rules_follow_the_homologacao_contract_with_a_stricter_uid_regex',
    ],
    [VERIFIER]: ['Acceptance_is_reevaluated_on_every_request'],
  }, { requiredFiles: [OPTIONS_CS, VERIFIER_CS, DI_CS] });
});

// ───────────────────────── uid fora da lista ─────────────────────────

test('FC-019 uid-fora-da-lista: só o uid listado autentica; caixa difere, dev. sem uid, uid com ponto e token de 133 caracteres são recusados', () => {
  requireEnv('FLUXO_TEST_POSTGRES', 'PostgreSQL 17 descartável com pgvector');
  requireEnv('FIRESTORE_EMULATOR_HOST', 'emulador do Firestore: a guarda do override o exige');
  gate({
    [VERIFIER]: ['Case_variants_malformed_and_overlong_tokens_are_refused'],
    [API]: ['Listed_uid_reads_config_while_unlisted_and_case_variants_get_401'],
  }, { requiredFiles: [VERIFIER_CS] });
});

// ───────────────────────── nunca admin ─────────────────────────

test('FC-019 nunca-admin: o principal dev só tem os quatro claims; mesmo com admin_access semeado, rotas admin dão 403 admin_required', () => {
  requireEnv('FLUXO_TEST_POSTGRES', 'PostgreSQL 17 descartável com pgvector');
  requireEnv('FIRESTORE_EMULATOR_HOST', 'emulador do Firestore para semear admin_access');
  const verifier = code(VERIFIER_CS);
  for (const claim of ['fluxoAdmin', 'adminRole', 'sign_in_second_factor', 'permissionsVersion', '"tenant"', 'new Claim("name"'])
    assert.ok(!verifier.includes(claim), `o verificador não pode produzir o claim ${claim}`);
  assert.ok(!/ILogger|logger/i.test(verifier), 'o verificador não pode logar nada');
  gate({
    [VERIFIER]: [
      'Dev_token_with_a_listed_uid_yields_the_exact_claims_and_no_privilege_claims',
      'Non_dev_tokens_delegate_to_the_real_verifier',
      'App_check_verification_always_delegates_and_never_accepts_dev_tokens',
      'Firebase_user_from_a_dev_principal_has_no_privilege_and_unverified_email',
    ],
    [API]: ['Dev_tokens_never_open_admin_routes_even_with_a_seeded_grant'],
  }, { requiredFiles: [VERIFIER_CS] });
});

// ───────────────────────── homologação e RN-02 ─────────────────────────

test('FC-019 nao-contorna-homologacao: homologação fechada dá o mesmo 404 de recurso desligado; ViaOwner e RN-02 seguem valendo', () => {
  requireEnv('FLUXO_TEST_POSTGRES', 'PostgreSQL 17 descartável com pgvector');
  requireEnv('FIRESTORE_EMULATOR_HOST', 'emulador do Firestore: a guarda do override o exige');
  assert.match(code(COMPOSE), /Homologacao__Creator__Mode:\s*"Allowlist"/, 'o compose não usa Mode=Open: a homologação real é exercitada');
  gate({
    [API]: [
      'Closed_homologacao_answers_the_same_404_as_a_disabled_feature',
      'Owner_and_member_paths_keep_working_and_rn02_roles_still_apply',
    ],
  }, { requiredFiles: [VERIFIER_CS] });
});

// ───────────────────────── sem seletor de conta ─────────────────────────

test('FC-019 sem-seletor-de-conta: nenhuma rota, header ou claim novo escolhe a conta; módulos protegidos ficam intocados', () => {
  for (const file of [OPTIONS_CS, VERIFIER_CS]) assert.ok(exists(file), `arquivo ausente: ${file}`);
  const verifier = code(VERIFIER_CS);
  assert.doesNotMatch(verifier, /businessId|X-Dev|X-Business/i, 'o verificador não pode saber de conta business');
  const offenders = walk(SEC, (f) => f.endsWith('.cs')).filter((f) => /"X-Dev|"X-Business|X-Dev-|X-Business-/.test(code(f)));
  assert.deepEqual(offenders, [], 'nenhum header de escolha de conta em Infrastructure/Security');
  const changed = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const protectedDirs = ['backend/src/Exemplo SaaS.Api/Modules/Creator/', 'backend/src/Exemplo SaaS.Api/Infrastructure/Homologacao/', 'backend/src/Exemplo SaaS.Api/Modules/Exemplo SaaSEmpresas/'];
  assert.deepEqual(changed.filter((f) => protectedDirs.some((dir) => f.startsWith(dir))), [],
    'Modules/Creator, Infrastructure/Homologacao e Modules/Exemplo SaaSEmpresas sem alteração nesta tarefa');
});

// ───────────────────────── produção sem override ─────────────────────────

test('FC-019 producao-sem-override: nenhum arquivo de produção ou CI liga o override ou define Development', () => {
  const settings = JSON.parse(read(APPSETTINGS));
  assert.equal(settings.Auth?.DevOverride?.Enabled, false, 'appsettings.json precisa citar Auth.DevOverride com false');
  const forbidden = ['.github/workflows', 'infra', 'backend/deploy/jobs', 'backend/deploy/secrets', 'services/creator-worker']
    .flatMap((dir) => walk(dir, () => true));
  forbidden.push(...walk('backend/deploy', (f) => /kustomize|render/i.test(f)));
  for (const extra of ['backend/Dockerfile', 'backend/cloudbuild.deploy.yaml', 'backend/deploy/docker-compose.local.yml', 'render.yaml'])
    if (exists(extra)) forbidden.push(extra);
  const offenders = forbidden.filter((f) => /DevOverride|Auth__DevOverride/i.test(read(f)));
  assert.deepEqual(offenders, [], 'DevOverride apareceu em arquivo de produção/CI');
  assert.doesNotMatch(read('backend/Dockerfile'), /ASPNETCORE_ENVIRONMENT\s*[=:]\s*Development/i, 'Dockerfile não define Development');
});

// ───────────────────────── compose ─────────────────────────

test('FC-019 compose: portas só em 127.0.0.1, sem env_file, variáveis fechadas e api com o override correto', (t) => {
  const raw = read(COMPOSE);
  assert.match(raw, /name:\s*fluxo-creator-local/, 'nome de projeto próprio para não colidir com o compose local');
  for (const expected of [
    '127.0.0.1:${CREATOR_LOCAL_PG_PORT:-15433}:5432',
    '127.0.0.1:${CREATOR_LOCAL_FS_PORT:-18089}:8089',
    '127.0.0.1:${CREATOR_LOCAL_API_PORT:-18080}:8080',
  ]) assert.ok(raw.includes(expected), `porta esperada ausente: ${expected}`);
  const published = [...raw.matchAll(/^\s*-\s+"?([^"\n]+?)"?\s*$/gm)].map((m) => m[1])
    .filter((entry) => /:\d+$/.test(entry) && entry.split(':').length >= 3);
  assert.ok(published.length >= 3, `esperava as três portas publicadas, achei ${published.length}`);
  for (const entry of published) assert.ok(entry.startsWith('127.0.0.1:'), `porta fora de 127.0.0.1: ${entry}`);
  assert.ok(!/^\s*env_file\s*:/m.test(raw), 'compose não pode usar env_file (o .env da raiz tem segredos do Jira)');
  const variables = [...raw.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::[-?][^}]*)?\}/g)].map((m) => m[1]);
  const allowed = (name) => name === 'FLUXO_TEST_USER_UID' || name === 'FLUXO_TEST_MEMBER_UID' || /^CREATOR_LOCAL_\w+_PORT$/.test(name) || name === 'HOME';
  assert.deepEqual(variables.filter((name) => !allowed(name)), [], 'variável fora da lista fechada do compose');
  assert.match(raw, /Auth__DevOverride__Enabled:\s*"true"/, 'api do compose liga o override');
  assert.match(raw, /Auth__DevOverride__AllowedUids:\s*"\$\{FLUXO_TEST_USER_UID:\?defina FLUXO_TEST_USER_UID\}/, 'a lista vem do ambiente do shell');
  assert.match(raw, /Creator__Enabled:\s*"true"/);
  assert.match(raw, /Homologacao__Creator__Mode:\s*"Allowlist"/);
  assert.match(raw, /FIRESTORE_EMULATOR_HOST:\s*"firestore:8089"/);
  assert.match(raw, /ASPNETCORE_ENVIRONMENT:\s*Development/, 'api sobe em Development');
  assert.match(raw, /\$\{HOME\}\/\.cache\/fluxo-creator-local\/emu\.jar:\/emu\.jar:ro/, 'bind do jar vem de $HOME');
  assert.match(raw, /\$\{HOME\}\/\.cache\/fluxo-creator-local\/firestore\.rules:\/firestore\.rules:ro/, 'bind das regras vem de $HOME');
  // Estrutural (comentários citam as palavras de propósito): nenhuma credencial montada nem Doppler em uso.
  assert.ok(!/^\s*-?\s*["']?GOOGLE_APPLICATION_CREDENTIALS["']?\s*[:=]/m.test(raw), 'GOOGLE_APPLICATION_CREDENTIALS no compose');
  assert.ok(!/\bdoppler\s+(run|config|secrets|exec)\b/i.test(raw), 'CLI do Doppler no compose');
  const emails = raw.match(/[\w.+-]+@[\w.-]+/g) ?? [];
  assert.deepEqual(emails, [], 'compose com e-mail literal');
  // Estrutura via docker compose config (manual-pendente sem Docker).
  const configEnv = { ...process.env, FLUXO_TEST_USER_UID: 'gate-user-compose', FLUXO_TEST_MEMBER_UID: '' };
  const docker = spawnSync('docker', ['compose', '-f', COMPOSE, 'config', '--format', 'json'],
    { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: configEnv, maxBuffer: 16 * 1024 * 1024 });
  if (docker.error || docker.status !== 0) {
    t.diagnostic(`manual-pendente: docker compose config indisponível (${docker.error?.message ?? docker.stderr?.slice(0, 200)})`);
    return;
  }
  const config = JSON.parse(docker.stdout);
  for (const service of ['postgres', 'schema', 'firestore', 'api'])
    assert.ok(config.services?.[service], `serviço ${service} ausente no compose`);
  assert.ok(!JSON.stringify(config.services).includes('"env_file"'), 'env_file no compose resolvido');
  assert.equal(config.services.api.environment.Auth__DevOverride__Enabled, 'true');
  for (const [name, service] of Object.entries(config.services))
    for (const port of service.ports ?? [])
      assert.ok(port.host_ip === '127.0.0.1' || String(port.published).startsWith('127.0.0.1:'), `${name}: porta fora de 127.0.0.1`);
});

// ───────────────────────── seed ─────────────────────────

test('FC-019 seed: seed-firestore.mjs cria a conta mínima no emulador, é idempotente, valida entrada e não imprime valores', async (t) => {
  requireEnv('FIRESTORE_EMULATOR_HOST', 'emulador do Firestore para o seed');
  const uid = `gate-user-${randomUUID().replaceAll('-', '')}`;
  const biz = `gate-biz-${randomUUID().replaceAll('-', '')}`;
  const run = (env) => spawnSync('node', [SEED], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...env } });
  const missing = run({ FLUXO_TEST_USER_UID: '', FLUXO_TEST_BUSINESS_ID: '' });
  assert.equal(missing.status, 2, 'sem variáveis o seed sai com código 2');
  const badHost = run({ FLUXO_TEST_USER_UID: uid, FLUXO_TEST_BUSINESS_ID: biz, FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:443' });
  assert.equal(badHost.status, 2, 'host fora do loopback/firestore é recusado');
  const badId = run({ FLUXO_TEST_USER_UID: 'gate.user', FLUXO_TEST_BUSINESS_ID: biz });
  assert.equal(badId.status, 2, 'uid com ponto é recusado pela regex');
  const ok = run({ FLUXO_TEST_USER_UID: uid, FLUXO_TEST_BUSINESS_ID: biz, FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST });
  assert.equal(ok.status, 0, `seed falhou: ${ok.stdout}\n${ok.stderr}`);
  assert.match(ok.stdout, /seed ok/, 'o seed imprime o resumo');
  assert.ok(!ok.stdout.includes(uid) && !ok.stderr.includes(uid), 'o seed imprimiu o uid');
  assert.ok(!ok.stdout.includes(biz) && !ok.stderr.includes(biz), 'o seed imprimiu o businessId');
  const again = run({ FLUXO_TEST_USER_UID: uid, FLUXO_TEST_BUSINESS_ID: biz });
  assert.equal(again.status, 0, 'o seed precisa ser idempotente');
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  const readDoc = await fetch(`http://${host}/v1/projects/fluxo-local/databases/fluxo/documents/businessProfiles/${biz}`,
    { headers: { authorization: 'Bearer owner' } });
  assert.equal(readDoc.status, 200, 'businessProfiles/<id> não encontrado no emulador');
  const doc = await readDoc.json();
  assert.equal(doc.fields?.ownerUids?.arrayValue?.values?.[0]?.stringValue, uid, 'ownerUids sem o uid do dono');
  assert.ok(doc.fields?.tradeName?.stringValue, 'tradeName ausente');
  // A API (registro real com o override ligado) enxerga o dono semeado no legado e responde 200 em /config.
  process.env.FLUXO_GATE_SEED_UID = uid;
  process.env.FLUXO_GATE_SEED_BIZ = biz;
  try {
    gate({ [API]: ['Seeded_legacy_owner_reads_the_config_as_owner'] }, { requiredFiles: [SEED, VERIFIER_CS] });
  } finally {
    delete process.env.FLUXO_GATE_SEED_UID;
    delete process.env.FLUXO_GATE_SEED_BIZ;
  }
});

// ───────────────────────── readme ─────────────────────────

test('FC-019 readme: README do ambiente local com os curls, placeholders e avisos; backend/README.md aponta para ele', () => {
  const readme = read(LOCAL_README);
  for (const needle of ['dev.<UID_DE_TESTE>', '<BUSINESS_ID>', '/api/v1/creator/config', '/api/v1/creator/brand-kit',
    '/api/v1/creator/geo/ufs', '/api/v1/creator/geo/municipios', 'Idempotency-Key', 'up.sh', 'down'])
    assert.ok(readme.includes(needle), `README sem ${needle}`);
  assert.match(readme, /não funciona localmente|upload.*não/i, 'README sem o limite de upload de ativos');
  assert.match(readme, /Development|Testing|só.*local|somente.*local/i, 'README sem o aviso de uso só local');
  const emails = readme.match(/[\w.+-]+@[\w.-]+/g) ?? [];
  for (const email of emails) assert.ok(email.endsWith('@example.test'), `README com e-mail fora do domínio reservado: ${email}`);
  const pointer = read('backend/README.md');
  assert.match(pointer, /deploy\/creator-local\/README\.md/, 'backend/README.md sem ponteiro para o ambiente local');
  assert.match(pointer, /dev\.<|Auth:DevOverride|Auth__DevOverride/, 'backend/README.md sem a regra do override');
  // E-mails: só a seção nova (o README inteiro tem e-mails legítimos de service account em outras seções).
  const section = pointer.match(/^## Teste local do Creator[\s\S]*?(?=^## )/m)?.[0] ?? '';
  assert.ok(section.includes('Auth__DevOverride'), 'backend/README.md sem a seção do override de FC-019');
  for (const email of section.match(/[\w.+-]+@[\w.-]+/g) ?? [])
    assert.ok(email.endsWith('@example.test'), `backend/README.md (seção FC-019) com e-mail fora do domínio reservado: ${email}`);
});

// ───────────────────────── sem identificador real ─────────────────────────

test('FC-019 sem-identificador-real: nenhum identificador real nos arquivos novos e alterados', (t) => {
  const files = [...new Set([...devFiles(), 'quality/test/delivery/fc-019.test.mjs',
    'quality/test/delivery/fc-dotnet/GateFc019Support.cs', 'quality/test/delivery/fc-dotnet/GateFc019OptionsTests.cs',
    'quality/test/delivery/fc-dotnet/GateFc019VerifierTests.cs', 'quality/test/delivery/fc-dotnet/GateFc019ApiTests.cs'])];
  for (const file of files) {
    assert.ok(exists(file), `arquivo ausente: ${file}`);
    let source = read(file);
    // O README do backend tem e-mails legítimos de service account em seções anteriores; vale só a seção nova.
    if (file === 'backend/README.md') source = source.match(/^## Teste local do Creator[\s\S]*?(?=^## )/m)?.[0] ?? '';
    const emails = source.match(/[\w.+-]+@[\w.-]+/g) ?? [];
    for (const email of emails) assert.ok(email.endsWith('@example.test'), `${file}: e-mail fora do domínio reservado`);
  }
  const real = process.env.FLUXO_CREATOR_REAL_IDS;
  if (!real) {
    t.diagnostic('manual-pendente: FLUXO_CREATOR_REAL_IDS ausente; a varredura contra os identificadores reais só roda na máquina do dono');
    return;
  }
  for (const value of real.split(/[;,]/).map((item) => item.trim()).filter((item) => item.length >= 6)) {
    const hits = execFileSync('git', ['grep', '-I', '-l', '-F', '--untracked', value], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    assert.equal(hits.trim(), '', 'um identificador real apareceu na árvore de trabalho');
  }
});

// ───────────────────────── regressão ─────────────────────────

test('FC-019 regressao: o registro novo não quebra os gates de FC-001, FC-002, FC-011 e FC-017 nem o container dos testes', () => {
  const settings = JSON.parse(read(APPSETTINGS));
  assert.deepEqual(settings.Homologacao.Creator, { Mode: 'Allowlist', AllowedUserUids: '', AllowedUserEmails: '', AllowedBusinessIds: '' },
    'Homologacao.Creator precisa continuar fechada por padrão');
  const di = code(DI_CS);
  assert.match(di, /AddSingleton<FirebaseTokenVerifier>/, 'o verificador concreto precisa continuar resolvível por tipo');
  assert.match(di, /DevOverrideTokenVerifier/, 'o decorador precisa existir no registro');
  gate({
    GateFc001ApiTests: ['Anonymous_gets_401_and_missing_business_gets_422', 'Caller_without_membership_gets_403',
      'Owner_admin_editor_viewer_get_200_with_their_permissions', 'Disabled_feature_answers_404_creator_disabled',
      'Response_never_exposes_document_or_email_fields'],
    GateFc001TeamTests: ['RequireMemberAsync_is_public_and_RequireAccessAsync_stays_closed'],
    GateFc011GeoApiTests: ['Anonymous_gets_401_and_disabled_feature_gets_404', 'Success_is_public_cacheable_with_a_strong_etag_and_304_on_match'],
    GateFc002AccessTests: ['Anonymous_gets_401_and_strangers_and_unknown_businesses_get_403',
      'Editor_and_viewer_read_but_cannot_write_while_owner_and_admin_write'],
    GateFc017ApiTests: ['Base_gate_settings_keep_the_creator_open_for_the_existing_gates'],
  }, {
    existing: ['ApiBoundaryTests.Every_module_denies_anonymous_requests'],
    requiredFiles: [OPTIONS_CS, VERIFIER_CS, DI_CS],
  });
});

