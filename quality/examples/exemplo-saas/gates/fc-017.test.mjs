// Gates FC-017 — acesso por homologação em produção (Homologacao): allowlist de usuários e contas business, sem plano.
// ANTES da implementação cada gate DEVE falhar.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-11-14-fluxo-creator FC-017 --baseline
// .NET exige o SDK, FLUXO_TEST_POSTGRES e, onde há conta só no legado, FIRESTORE_EMULATOR_HOST (emulador com as regras).
// Reaproveita fc-gate-helper.mjs / fc-001-gate-helper.mjs (runDotnetGate, read, walk...) e GateFcSupport.cs / GateFc002Support.cs; os
// templates próprios são fc-dotnet/GateFc017*.cs (formas fixadas no cabeçalho de GateFc017Support.cs).
// Regra de ouro: NENHUM uid, e-mail ou businessId real em gate nem em teste. Só `gate-*`, `*@example.test` e GUIDs gerados na hora.
// Fora do eval (manual-pendente): conferir `email_verified` num ID token real do Firebase (o claim é padrão, mas o caminho de usuário
// do app nunca o leu neste repositório); varredura contra os identificadores reais só roda onde existir FLUXO_CREATOR_REAL_IDS.
// Gate adicional (não sugerido na spec): FC-017-REGRESSAO-BIL. O eval.mjs mata cada gate em 120 s e os templates de BIL vivem em outro
// pacote (bil-dotnet/), então não cabem no mesmo `dotnet test` de FC-017-REGRESSAO.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { APPSETTINGS, CREATOR_DIR, ROOT, exists, keyPaths, leaves, read, requireEnv, runDotnetGate, stripComments, walk } from './fc-gate-helper.mjs';
import { runDotnetGate as runBilGate } from './bil-gate-helper.mjs';

const HOM = 'backend/src/Exemplo SaaS.Api/Infrastructure/Homologacao';
const PROBE = 'backend/src/Exemplo SaaS.Api/Modules/Exemplo SaaSEmpresas/BusinessTeamMembershipProbe.cs';
const PROGRAM = 'backend/src/Exemplo SaaS.Api/Program.cs';
const SPEC = 'docs/entregas/2026-11-14-fluxo-creator/specs/FC-017.md';
const SUPPORT = ['GateFc002Support.cs', 'GateFc017Support.cs'];
const homFiles = (name) => `${HOM}/${name}`;
const HOM_FILES = ['HomologacaoOptions.cs', 'HomologacaoEvaluator.cs', 'HomologacaoUser.cs', 'HomologacaoRequirement.cs', 'HomologacaoMiddleware.cs',
  'IHomologacaoAccountProbe.cs', 'HomologacaoStartupReporter.cs', 'HomologacaoServiceCollectionExtensions.cs'];

// Gates compartilham classes xUnit: cada um roda só os métodos que nomeia.
const gate = (classes, options = {}) => runDotnetGate(classes, { byMethod: true, support: SUPPORT, postgres: true, ...options });
const noPg = (classes, options = {}) => gate(classes, { postgres: false, ...options });
const homSources = () => walk(HOM, (f) => f.endsWith('.cs'));
const code = (file) => stripComments(read(file));
const settings = () => JSON.parse(read(APPSETTINGS));
const closedEntry = { Mode: 'Allowlist', AllowedUserUids: '', AllowedUserEmails: '', AllowedBusinessIds: '' };

const OPTIONS = 'GateFc017OptionsTests';
const EVALUATOR = 'GateFc017EvaluatorTests';
const MIDDLEWARE = 'GateFc017MiddlewareTests';
const USER = 'GateFc017UserTests';
const API = 'GateFc017ApiTests';
const HOST = 'GateFc017HostTests';
const OWNER = 'GateFc017OwnerTests';

function assertAppsettingsHomologacao() {
  const homologacao = settings().Homologacao;
  assert.ok(homologacao, 'appsettings.json sem a seção Homologacao');
  assert.deepEqual(homologacao.Creator, closedEntry, 'Homologacao.Creator precisa vir fechada (Allowlist e as três listas vazias)');
  assert.deepEqual(homologacao.Billing, closedEntry, 'Homologacao.Billing precisa vir fechada e inerte (Allowlist e as três listas vazias)');
  assert.deepEqual(Object.keys(homologacao).sort(), ['Billing', 'Creator'], 'só Creator e Billing entram em Homologacao');
}

const appsettingsFiles = () => walk('backend/src/Exemplo SaaS.Api', (f) => /(^|\/)appsettings[^/]*\.json$/.test(f));

// ───────────────────────── opções e validação ─────────────────────────

test('FC-017 opcoes: appsettings com Homologacao fechada e sem identificador; subida recusa entrada inválida e Open fora de Development e Testing', () => {
  assertAppsettingsHomologacao();
  const files = appsettingsFiles();
  assert.ok(files.length >= 2, 'appsettings*.json da API ausentes');
  for (const file of files) {
    const json = JSON.parse(read(file));
    for (const key of keyPaths(json).filter((k) => /(^|\.)Allowed(UserUids|UserEmails|BusinessIds)$/.test(k))) {
      const value = key.split('.').reduce((node, part) => node?.[part], json);
      assert.equal(value, '', `${file}: ${key} precisa ficar vazio (identificadores vêm do Doppler)`);
    }
    if (file.endsWith('appsettings.Development.json')) assert.equal(json.Homologacao, undefined, 'appsettings.Development.json não muda: herda Allowlist fechado (D4)');
    assert.ok(!leaves(json.Homologacao ?? {}).some((v) => typeof v === 'string' && (/@/.test(v) || v.length > 12)), `${file}: valor suspeito em Homologacao`);
  }
  assert.ok(exists(homFiles('HomologacaoOptions.cs')), 'HomologacaoOptions.cs ausente');
  assert.match(code(homFiles('HomologacaoOptions.cs')), /enum\s+HomologacaoMode\b/, 'HomologacaoMode ausente');
  noPg({ [OPTIONS]: ['Invalid_entries_stop_the_startup_citing_the_key_and_never_the_value', 'Open_is_refused_outside_Development_and_Testing_and_allowed_inside', 'Invalid_entry_stops_the_real_api_startup'] },
    { requiredFiles: [homFiles('HomologacaoOptions.cs'), homFiles('HomologacaoServiceCollectionExtensions.cs')] });
});

test('FC-017 entrada-obrigatoria: sem a entrada Creator a subida falha; só com Mode sobe e fica fechada; Billing não é obrigatória', () => {
  assertAppsettingsHomologacao();
  const creator = code(`${CREATOR_DIR}/CreatorModule.cs`);
  assert.match(creator, /RequireHomologacaoEntry\(/, 'AddCreatorModule precisa chamar RequireHomologacaoEntry');
  const calls = walk('backend/src/Exemplo SaaS.Api', (f) => f.endsWith('.cs')).filter((f) => /RequireHomologacaoEntry\(\s*"billing"/i.test(code(f)));
  assert.deepEqual(calls, [], 'Billing não registra entrada obrigatória nesta tarefa (D11)');
  noPg({ [OPTIONS]: ['Creator_entry_is_required_and_the_billing_entry_is_not', 'Entry_with_only_the_mode_boots_and_stays_closed'] },
    { requiredFiles: [homFiles('HomologacaoServiceCollectionExtensions.cs')] });
});

// ───────────────────────── avaliador ─────────────────────────

test('FC-017 avaliacao: Unrestricted, Open, ViaUser, ViaOwner, ViaBusinessList e Denied com a funcionalidade como parâmetro; sem módulo na infraestrutura', () => {
  const offenders = homSources().filter((f) => /Exemplo SaaS\.Api\.Modules\./.test(code(f)));
  assert.ok(exists(homFiles('HomologacaoEvaluator.cs')), 'HomologacaoEvaluator.cs ausente');
  assert.deepEqual(offenders, [], 'Infrastructure/Homologacao não pode referenciar módulo algum (Creator, Billing, Exemplo SaaSEmpresas)');
  noPg({
    [EVALUATOR]: [
      'Parse_handles_separators_blanks_duplicates_case_and_empty_inputs', 'Without_an_entry_the_feature_is_unrestricted_and_open_mode_is_open_and_keys_ignore_case',
      'Rule_one_authorizes_by_uid_ordinal_or_verified_email_without_case_and_never_by_unverified_email', 'Features_are_isolated_from_each_other',
      'Account_is_authorized_by_the_owner_uid_or_the_business_list_and_only_with_an_active_link',
      'The_probe_is_not_touched_when_there_is_no_list_to_consult_and_owners_never_match_by_email', 'Probe_failures_propagate_and_never_become_a_release',
    ],
  }, { requiredFiles: [homFiles('HomologacaoEvaluator.cs')] });
});

test('FC-017 billing-config: Homologacao:Billing validada como a de Creator, variáveis __ fazem bind e o mecanismo opt-in funciona só com endpoint de teste', () => {
  assert.deepEqual(settings().Homologacao?.Billing, closedEntry, 'Homologacao.Billing precisa existir fechada no appsettings.json');
  noPg({
    [OPTIONS]: ['Billing_entry_is_validated_and_guarded_like_creator', 'Environment_variable_names_bind_to_the_homologacao_keys'],
    [MIDDLEWARE]: ['Billing_requirement_closed_denies_with_the_default_404_and_user_rules_open_the_door', 'Billing_requirement_releases_by_owner_or_business_list_only_with_an_active_link'],
  }, { requiredFiles: [homFiles('HomologacaoMiddleware.cs'), homFiles('HomologacaoRequirement.cs')] });
});

// Linhas de Billing e de PlanFeatureMiddleware em Program.cs antes da FC-017 (comparação por conteúdo, na ordem).
const PROGRAM_BILLING_LINES = [
  'using Exemplo SaaS.Api.Modules.Billing;',
  'using Exemplo SaaS.Api.Modules.Billing.Application;',
  'builder.Services.AddBillingModule(builder.Configuration);',
  'builder.Services.AddBillingWebhooks(builder.Configuration);',
  'if (await BillingJobs.TryRunAsync(args, app.Services)) return;',
  '// Lê a configuração, não IOptions<BillingOptions>: Value rodaria antes a validação de provedor e esconderia esta trava.',
  'if (app.Configuration.GetValue<bool>($"{BillingOptions.SectionName}:{nameof(BillingOptions.Enabled)}"))',
  'throw new InvalidOperationException($"Production with Billing:Enabled refused: {string.Join(\' \', cryptoProblems)}");',
  '// Só rota com RequiresPlanFeature consulta o plano: recurso existente passa direto.',
  'app.UseMiddleware<PlanFeatureMiddleware>();',
  'app.MapBillingWebhookEndpoints();',
  'v1.MapBillingEndpoints();',
  'v1.MapAdminBillingEndpoints();',
];

test('FC-017 billing-inalterado: nenhuma rota de Billing carrega o metadado, Modules/Billing e Program.cs de Billing intactos, respostas iguais com Homologacao fechada', () => {
  assert.deepEqual(settings().Homologacao?.Billing, closedEntry, 'Homologacao.Billing precisa existir fechada (e inerte) no appsettings.json');
  assert.ok(exists(homFiles('HomologacaoRequirement.cs')), 'HomologacaoRequirement.cs ausente: o gate só vale com o mecanismo presente');
  const billing = walk('backend/src/Exemplo SaaS.Api/Modules/Billing', (f) => f.endsWith('.cs')).filter((f) => /Homologacao/i.test(read(f)));
  assert.deepEqual(billing, [], 'Modules/Billing não pode citar Homologacao (D8: o wiring é da branch dos Exemplo SaaS Tokens)');
  const lines = read(PROGRAM).split('\n').map((l) => l.trim()).filter((l) => /Billing|PlanFeature/.test(l));
  assert.deepEqual(lines, PROGRAM_BILLING_LINES, 'as linhas de Billing e de PlanFeatureMiddleware em Program.cs mudaram');
  assert.deepEqual(walk('backend/src/Exemplo SaaS.Api/Modules/Billing', (f) => f.endsWith('.cs')).filter((f) => /HomologacaoRequirement|HomologacaoMiddleware/.test(read(f))), []);
  gate({
    [API]: ['Only_creator_routes_carry_the_requirement_and_billing_routes_exist_without_it', 'Billing_and_team_routes_answer_the_same_with_homologacao_closed_or_open'],
  }, { requiredFiles: [homFiles('HomologacaoRequirement.cs')] });
});

test('FC-017 feature-sem-entrada-aberta: funcionalidade sem entrada abre sem tocar o probe; endpoint sem metadado passa sem resolver serviço; remover a entrada reabre', () => {
  noPg({ [MIDDLEWARE]: ['Feature_without_an_entry_opens_for_any_user_without_touching_the_probe', 'Endpoint_without_the_metadata_passes_without_resolving_any_service', 'Removing_the_entry_reopens_the_same_route_without_changing_it'] },
    { requiredFiles: [homFiles('HomologacaoMiddleware.cs')] });
});

// ───────────────────────── API (PostgreSQL) ─────────────────────────

test('FC-017 fail-closed: entrada com as três listas vazias não deixa ninguém passar; Mode ausente é Allowlist; e-mail não verificado nega', () => {
  gate({ [API]: ['Empty_lists_close_the_creator_for_everyone_even_the_owner_of_the_account', 'Missing_mode_means_allowlist_and_only_emails_with_an_unverified_user_stays_out'] },
    { requiredFiles: [homFiles('HomologacaoEvaluator.cs')] });
});

test('FC-017 api-usuario: uid liberado entra com o papel de sempre, liberado sem vínculo recebe 403 e não liberado recebe 404 creator_disabled', () => {
  gate({ [API]: ['Listed_uids_reach_the_creator_with_their_roles_and_everyone_else_gets_404'] }, { requiredFiles: [homFiles('HomologacaoMiddleware.cs')] });
});

test('FC-017 api-business: válvula AllowedBusinessIds libera só membro ativo, papel segue valendo, não membro e revogado recebem 404, geo só com businessId', () => {
  gate({ [API]: ['Business_list_valve_releases_active_members_only_and_never_answers_403_to_the_rest'] }, { requiredFiles: [homFiles('HomologacaoMiddleware.cs')] });
});

test('FC-017 email-verificado: FirebaseUser.EmailVerified lê o claim, e-mail verificado libera sem diferenciar caixa e as demais formas negam', () => {
  const user = read('backend/src/Exemplo SaaS.Api/Infrastructure/Security/FirebaseUser.cs');
  assert.match(user, /bool\s+EmailVerified\s*=\s*false/, 'FirebaseUser sem `bool EmailVerified = false`');
  assert.match(user, /email_verified/, 'FirebaseUser não lê o claim email_verified');
  gate({ [USER]: ['FirebaseUser_reads_email_verified_as_the_last_parameter_with_a_false_default'], [API]: ['Listed_verified_email_releases_and_every_other_form_stays_out'] },
    { requiredFiles: [homFiles('HomologacaoMiddleware.cs')] });
});

test('FC-017 nome-nao-autoriza: claim name/displayName nunca autoriza e nada de Homologacao lê o nome', () => {
  const files = homSources();
  assert.ok(files.length > 0, 'Infrastructure/Homologacao ausente');
  const forbidden = [/\bDisplayName\b/, /["'`](?:name|displayName)["'`]/i, /\bFirebaseUser\.Name\b/, /\b(?:user|firebaseUser|caller|principal)\.Name\b/i, /FindFirstValue\(\s*["']name["']/];
  const offenders = files.filter((f) => forbidden.some((re) => re.test(code(f))));
  assert.deepEqual(offenders, [], 'Infrastructure/Homologacao não pode ler o nome do usuário');
  gate({ [USER]: ['HomologacaoUser_carries_uid_email_and_verification_but_no_name'], [API]: ['A_name_or_display_name_equal_to_a_listed_value_never_authorizes'] },
    { requiredFiles: [homFiles('HomologacaoUser.cs')] });
});

test('FC-017 dono-libera-conta: conta do dono autorizado (por uid) libera membros ativos; e-mail do perfil, dono por e-mail e dono não listado não herdam; legado herda igual', () => {
  requireEnv('FIRESTORE_EMULATOR_HOST', 'emulador Firestore para a conta só no legado');
  gate({
    [OWNER]: ['A_listed_owner_releases_every_active_member_and_the_role_still_applies', 'An_owner_listed_only_by_email_passes_himself_but_his_members_do_not_inherit',
      'The_profile_email_of_the_owner_never_releases_the_account', 'A_business_only_in_the_legacy_directory_inherits_the_same_way', 'Owner_resolution_follows_the_team_service_precedence_without_an_actor'],
  }, { requiredFiles: [PROBE] });
});

test('FC-017 falha-nunca-libera: erro do probe vira 5xx sem vazar identificador e nada de "liberado" fica em cache entre requisições', () => {
  gate({ [HOST]: ['Probe_failures_answer_5xx_never_200_and_leak_nothing', 'A_release_is_never_cached_between_requests'] }, { requiredFiles: [homFiles('IHomologacaoAccountProbe.cs')] });
});

test('FC-017 team-api-estavel: BusinessTeamService só ganha GetOwnerUidsAsync público; sonda em Exemplo SaaSEmpresas; GateFc001TeamTests segue verde sem edição', () => {
  assert.ok(exists(PROBE), 'BusinessTeamMembershipProbe.cs ausente');
  assert.doesNotMatch(read(PROBE), /creator\./i, 'a sonda não cita creator. (FC-001-SEM-REGRESSAO-TEAM)');
  const module = code('backend/src/Exemplo SaaS.Api/Modules/Exemplo SaaSEmpresas/Exemplo SaaSEmpresasModule.cs');
  assert.match(module, /BusinessTeamMembershipProbe/, 'Exemplo SaaSEmpresasModule não registra a sonda');
  assert.match(module, /IHomologacaoAccountProbe/, 'Exemplo SaaSEmpresasModule não registra IHomologacaoAccountProbe');
  noPg({
    [USER]: ['Team_service_keeps_its_api_and_only_gains_the_public_owner_resolution', 'The_probe_lives_in_fluxo_empresas_and_the_evaluator_knows_no_module'],
    GateFc001TeamTests: ['RequireMemberAsync_is_public_and_RequireAccessAsync_stays_closed'],
  }, { requiredFiles: [PROBE] });
});

test('FC-017 404-uniforme: negado é idêntico ao Creator desligado em status, corpo e cabeçalhos, inclusive JSON malformado e rota {id:guid}; anônimo segue 401', () => {
  gate({ [API]: ['Denied_looks_exactly_like_a_disabled_creator_even_with_a_malformed_body'] }, { requiredFiles: [homFiles('HomologacaoMiddleware.cs')] });
});

test('FC-017 cobertura-rotas: toda rota do Creator (atual e futura) carrega o metadado e expõe businessId; ordem do middleware e constantes únicas', () => {
  const program = read(PROGRAM);
  const at = (needle) => {
    const index = program.indexOf(needle);
    assert.ok(index >= 0, `Program.cs sem ${needle}`);
    return index;
  };
  assert.ok(at('AddHomologacao(') < at('AddCreatorModule('), 'AddHomologacao precisa vir antes de AddCreatorModule');
  assert.ok(at('UseMiddleware<WorkerOidcMiddleware>') < at('UseMiddleware<HomologacaoMiddleware>'), 'HomologacaoMiddleware logo depois de WorkerOidcMiddleware');
  assert.ok(at('UseMiddleware<HomologacaoMiddleware>') < at('UseRateLimiter'), 'HomologacaoMiddleware antes de UseRateLimiter (negado não consome o balde)');
  const module = code(`${CREATOR_DIR}/CreatorModule.cs`);
  assert.match(module, /WithMetadata\([^)]*HomologacaoRequirement/, 'o grupo /creator precisa declarar HomologacaoRequirement por WithMetadata');
  const literals = walk(CREATOR_DIR, (f) => f.endsWith('.cs')).flatMap((f) => [...code(f).matchAll(/"creator_disabled"/g)].map(() => f));
  assert.equal(literals.length, 1, `"creator_disabled" deve ser uma constante única do módulo, houve ${literals.length} literais`);
  gate({ [API]: ['Every_creator_route_carries_the_requirement_and_exposes_a_business_id'] }, { postgres: false, requiredFiles: [homFiles('HomologacaoRequirement.cs')] });
});

test('FC-017 sem-pii-log: log de arranque só com chave, Mode e contagens; nenhum uid, e-mail, id ou lista em log; middleware e avaliador não logam', () => {
  for (const name of ['HomologacaoMiddleware.cs', 'HomologacaoEvaluator.cs']) {
    assert.ok(exists(homFiles(name)), `${name} ausente`);
    assert.doesNotMatch(code(homFiles(name)), /\bILogger\b|\blogger\b|\.Log(?:Trace|Debug|Information|Warning|Error|Critical)?\(/, `${name} não pode logar nada`);
  }
  gate({ [HOST]: ['Logs_carry_only_feature_mode_and_counts_and_never_identifiers_emails_or_lists'] }, { requiredFiles: [homFiles('HomologacaoStartupReporter.cs')] });
});

// ───────────────────────── varreduras estáticas ─────────────────────────

const listFiles = () => execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n').filter((f) => f && exists(f));
const readSafe = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** Atribuição de valor a Homologacao__*__Allowed*: só vazio, `<placeholder>`, `none` ou `gate-*` sintético. */
export function suspiciousAssignments(text) {
  const out = [];
  for (const m of text.matchAll(/Homologacao__[A-Za-z0-9]+__Allowed\w*[`"'\]]*[ \t]*[=:][ \t]*[`"']?([^\s"'`,;)<>|]*)/g)) {
    const value = m[1];
    if (value && !/^(?:gate-|none$|\.{2,}$|…)/.test(value)) out.push(m[0]);
  }
  return out;
}

const EMAIL = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
export const foreignEmails = (text) => [...text.matchAll(EMAIL)].filter((m) => m[2].toLowerCase() !== 'example.test').map((m) => m[0]);

test('FC-017 sem-identificador-real: varredura negativa do detector, e a árvore não atribui valor real a Homologacao__*, não tem literal de uid e usa só example.test', (t) => {
  // negativo: o detector precisa pegar o erro e deixar passar o legítimo (amostras montadas por partes para não se autodenunciarem).
  const H = `Homologacao${'__'}`;
  const mail = (local, host) => `${local}${'@'}${host}`;
  assert.equal(suspiciousAssignments(`${H}Creator__AllowedUserUids=abc123def456`).length, 1);
  assert.equal(suspiciousAssignments(`${H}Billing__AllowedUserEmails: "${mail('someone', 'x.com')}"`).length, 1);
  assert.deepEqual(suspiciousAssignments([`${H}Creator__AllowedUserUids=`, `${H}Creator__AllowedUserUids=none`, `${H}Creator__AllowedUserUids="gate-user-a;gate-user-b"`,
    `\`${H}Creator__AllowedUserUids\` | \`<uid>\``].join('\n')), []);
  assert.deepEqual(foreignEmails(`${mail('x', 'example.test')} ${mail('y', 'Example.TEST')}`), []);
  assert.deepEqual(foreignEmails(mail('dono', 'gmail.com')), [mail('dono', 'gmail.com')]);

  assertAppsettingsHomologacao();
  for (const file of appsettingsFiles()) {
    const json = JSON.parse(read(file));
    for (const key of keyPaths(json).filter((k) => /Allowed(UserUids|UserEmails|BusinessIds)$/.test(k))) assert.equal(key.split('.').reduce((n, p) => n?.[p], json), '', `${file}: ${key}`);
  }

  const files = listFiles();
  const scanned = files.filter((f) => /^\.github\/workflows\//.test(f) || /\.(tf|tfvars|tsv|md|mjs|cs|ya?ml|json|sh)$/.test(f) || /docker-compose/.test(f))
    .filter((f) => !/(^|\/)(node_modules|bin|obj|dist)\//.test(f) && !/\.min\./.test(f) && !/package-lock\.json$/.test(f));
  const assigned = scanned.flatMap((f) => suspiciousAssignments(readSafe(f)).map((hit) => `${f}: ${hit}`));
  assert.deepEqual(assigned, [], 'valor atribuído a Homologacao__*__Allowed* fora de gate-*, none ou vazio');

  const csTargets = [...homSources(), PROBE, ...walk(CREATOR_DIR, (f) => f.endsWith('.cs')), ...walk('quality/test/delivery/fc-dotnet', (f) => /GateFc017.*\.cs$/.test(f))].filter(exists);
  const literal = csTargets.flatMap((f) => readSafe(f).split('\n').filter((line) => /Allowed/.test(line) && /["'](?!Homologacao|Allowed)[A-Za-z0-9_-]{20,}["']/.test(line)).map((line) => `${f}: ${line.trim()}`));
  assert.deepEqual(literal, [], 'literal alfanumérico de 20+ caracteres perto de Allowed (uid ou id real?)');

  const readmeSection = (() => {
    const readme = read('backend/README.md');
    const match = readme.match(/^#+ .*Homologa[cç][aã]o[^\n]*\n[\s\S]*?(?=^## |$(?![\s\S]))/m);
    return match ? match[0] : '';
  })();
  const emailTargets = [[SPEC, read(SPEC)], ['backend/README.md#Homologacao', readmeSection], ['fc-017.test.mjs', readSafe('quality/test/delivery/fc-017.test.mjs')],
    ...csTargets.map((f) => [f, readSafe(f)])];
  const emails = emailTargets.flatMap(([name, text]) => foreignEmails(text).map((hit) => `${name}: ${hit}`));
  assert.deepEqual(emails, [], 'e-mail literal fora do domínio reservado example.test');
  assert.ok(readmeSection === '' || !/Homologacao__[A-Za-z]+__Allowed\w*\s*=\s*\S+@/.test(readmeSection));

  const real = process.env.FLUXO_CREATOR_REAL_IDS;
  if (!real) {
    t.diagnostic('manual-pendente: FLUXO_CREATOR_REAL_IDS ausente; a varredura contra os identificadores reais só roda na máquina do dono');
    return;
  }
  for (const value of real.split(/[,;\s]+/).filter((v) => v.length >= 6)) {
    let found = '';
    try {
      found = execFileSync('git', ['grep', '-I', '-l', '-F', '--untracked', '-e', value], { cwd: ROOT, encoding: 'utf8' });
    } catch (error) {
      assert.equal(error.status, 1, `git grep falhou: ${error.message.split('\n')[0]}`);
    }
    assert.equal(found, '', 'identificador real encontrado na árvore de trabalho (o valor não é exibido)');
  }
});

test('FC-017 desacoplamento-tokens: nada de Billing, plano, entitlement ou Exemplo SaaS Token no acesso; sem Creator:Access nem Business:Access; limites seguem em CreatorOptions', () => {
  for (const name of HOM_FILES) assert.ok(exists(homFiles(name)), `${name} ausente em Infrastructure/Homologacao`);
  const access = [...homSources(), PROBE, `${CREATOR_DIR}/CreatorModule.cs`, `${CREATOR_DIR}/Application/CreatorAccess.cs`, `${CREATOR_DIR}/Application/CreatorAccessPolicy.cs`];
  const offenders = access.filter((f) => /Billing|PlanFeature|Entitlement|Exemplo SaaSToken|Modules\.Billing/i.test(code(f)));
  assert.deepEqual(offenders, [], 'o acesso por homologação não pode depender de Billing, plano ou tokens');
  const json = settings();
  assert.deepEqual(keyPaths(json.Homologacao ?? {}).filter((k) => /(^|\.)(plan|price|tier)/i.test(k)), [], 'Homologacao sem chave plan, price ou tier');
  assert.equal(json.Creator?.Access, undefined, 'Creator:Access não existe');
  assert.equal(json.Business?.Access, undefined, 'Business:Access não existe');
  const sources = walk('backend/src/Exemplo SaaS.Api', (f) => f.endsWith('.cs'));
  assert.deepEqual(sources.filter((f) => /Creator:Access|Business:Access|Creator__Access|Business__Access/.test(read(f))), [], 'Creator:Access ou Business:Access no código');
  const options = code(`${CREATOR_DIR}/CreatorOptions.cs`);
  assert.doesNotMatch(options, /Homologacao|AllowedUser|AllowedBusiness/, 'CreatorOptions não muda: limites seguem globais');
  assert.doesNotMatch(read(`${CREATOR_DIR}/Contracts/Responses.cs`), /Homologacao|Allowlist/, 'GET /config mantém o payload');
  const canonical = read('.claude/hooks/lib/regras.mjs');
  assert.doesNotMatch(canonical, /Homologacao/, 'HomologacaoMode é enum só de configuração: fora de CANONICAL_ENUMS');
  assert.doesNotMatch(read(`${CREATOR_DIR}/Domain/CreatorEnums.cs`), /Homologacao/);
  assert.doesNotMatch(read('ofluxo_site/src/platform/domain/creator-enums.ts'), /Homologacao/);
});

// ───────────────────────── regressão ─────────────────────────

test('FC-017 regressao: com a edição de GateFc.Settings os gates de FC-001, FC-002 e FC-011, o Billing existente e a fronteira anônima seguem verdes', () => {
  assert.match(read('quality/test/delivery/fc-dotnet/GateFcSupport.cs'), /\["Homologacao:Creator:Mode"\]\s*=\s*"Open"/, 'GateFc.Settings precisa definir Homologacao:Creator:Mode como Open');
  assertAppsettingsHomologacao();
  gate({
    GateFc001ApiTests: ['Anonymous_gets_401_and_missing_business_gets_422', 'Caller_without_membership_gets_403', 'Owner_admin_editor_viewer_get_200_with_their_permissions',
      'Unrecognized_member_role_gets_403_creator_access_denied', 'Disabled_feature_answers_404_creator_disabled', 'Payload_carries_every_limit_viewport_and_enum_from_the_spec',
      'Response_never_exposes_document_or_email_fields'],
    GateFc001TeamTests: ['RequireMemberAsync_is_public_and_RequireAccessAsync_stays_closed'],
    GateFc011GeoApiTests: ['Anonymous_gets_401_and_disabled_feature_gets_404', 'Success_is_public_cacheable_with_a_strong_etag_and_304_on_match', 'Payload_has_no_document_identity_candidate_or_electoral_fields'],
    GateFc002AccessTests: ['Anonymous_gets_401_and_strangers_and_unknown_businesses_get_403', 'Editor_and_viewer_read_but_cannot_write_while_owner_and_admin_write',
      'Assets_and_templates_of_another_business_answer_404_never_403', 'Responses_never_carry_uid_email_document_bucket_or_storage_paths'],
    [API]: ['Base_gate_settings_keep_the_creator_open_for_the_existing_gates'],
  }, {
    existing: ['BillingApiTests.Disabled_module_answers_404_and_keeps_writes_closed', 'BillingApiTests.Owner_of_another_business_cannot_read_the_invoice_or_the_subject',
      'ApiBoundaryTests.Every_module_denies_anonymous_requests'],
    requiredFiles: [homFiles('HomologacaoEvaluator.cs')],
  });
});

test('FC-017 regressao-bil: os gates de equipe e acesso (BIL-002) e de admin (BIL-003, FirebaseUser posicional) seguem verdes sem edição', () => {
  assertAppsettingsHomologacao();
  assert.match(read('backend/src/Exemplo SaaS.Api/Infrastructure/Security/FirebaseUser.cs'), /EmailVerified/, 'FirebaseUser sem EmailVerified');
  requireEnv('FLUXO_TEST_POSTGRES', 'PostgreSQL 17 descartável com pgvector');
  // excludeBroken:false como nos gates BIL-007 em diante: o Mobility compila; a exclusão antiga de GtfsStaticFeedTests quebraria TransitSyncTests.
  runBilGate({
    GateBil002DomainTests: ['Business_team_exposes_require_manager_without_opening_require_access', 'Billing_is_off_by_default_with_the_stub_provider'],
    GateBil003AdminTests: ['Billing_read_is_implied_by_manage_and_refund_and_denied_to_legal', 'Manual_plan_routes_enforce_permissions_and_recent_auth'],
  }, { excludeBroken: false, existing: ['ApiBoundaryTests.Unknown_future_paths_are_not_anonymous'] });
});

// ───────────────────────── documentação ─────────────────────────

test('FC-017 docs: README do backend com a seção Homologacao, ponteiros no desenho e no UX, nomes exatos das oito variáveis e nenhum identificador', () => {
  const readme = read('backend/README.md');
  const match = readme.match(/^#+ .*Homologa[cç][aã]o[^\n]*FC-017[^\n]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m);
  assert.ok(match, 'backend/README.md sem a seção "Homologação em produção (`Homologacao`, FC-017)"');
  const section = match[1];
  for (const feature of ['Creator', 'Billing'])
    for (const key of ['AllowedUserUids', 'AllowedUserEmails', 'AllowedBusinessIds', 'Mode']) assert.ok(section.includes(`Homologacao__${feature}__${key}`), `README sem a variável Homologacao__${feature}__${key}`);
  for (const [needle, why] of [[/sem entrada/i, 'sem entrada = aberto'], [/lista vazia|listas vazias/i, 'lista vazia = ninguém'], [/e-mail verificado/i, 'e-mail verificado'], [/AllowedBusinessIds/, 'válvula'],
    [/HomologacaoRequirement/, 'metadado para a branch dos tokens'], [/Mode=Open/, 'guarda de Open'], [/inerte/i, 'Billing inerte'], [/businessId/, 'convenção de businessId'], [/404/, '404 uniforme'], [/dono/i, 'derivação por dono']])
    assert.match(section, needle, `README sem: ${why}`);
  const design = read('docs/parking-lot/fluxo-creator.md');
  const secrets = design.match(/^## 6\. Secrets no Doppler[\s\S]*?(?=^## 7\.)/m)?.[0] ?? '';
  assert.match(secrets, /Homologacao__Creator__AllowedUserUids/, 'fluxo-creator.md §6 sem Homologacao__Creator__*');
  assert.match(secrets, /sem plano/i, 'fluxo-creator.md §6 sem a nota "sem plano; Homologacao é o único portão"');
  const open = design.match(/^## 9\. Decisões abertas[\s\S]*?(?=^## 10\.)/m)?.[0] ?? '';
  const item4 = open.match(/^4\.[\s\S]*?(?=^5\.)/m)?.[0] ?? '';
  assert.match(item4, /FC-017/, 'fluxo-creator.md §9 item 4 sem ponteiro para FC-017');
  assert.match(item4, /abert/i, 'fluxo-creator.md §9 item 4 precisa dizer que a decisão segue aberta');
  const ux = read('docs/parking-lot/fluxo-creator-ux.md').split('\n').find((l) => l.startsWith('| RN-04')) ?? '';
  assert.match(ux, /homologa/i, 'fluxo-creator-ux.md RN-04 sem a nota de homologação por allowlist');
  assert.match(ux, /404/, 'fluxo-creator-ux.md RN-04 sem "GET /config 404 esconde a aba"');
  // fluxo-token.md vive na branch dos tokens; se existir aqui, precisa do ponteiro curto.
  if (exists('docs/parking-lot/fluxo-token.md')) {
    const token = read('docs/parking-lot/fluxo-token.md');
    assert.match(token, /Homologacao:Billing/);
    assert.match(token, /HomologacaoRequirement\("billing"\)/);
  }
});
