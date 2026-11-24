// Gates DV-002 — módulo Debates na API .NET (blocos 2A–2G) e permissões debates.* em Functions/admin-web.
// ANTES da implementação cada gate DEVE falhar: as classes xUnit nomeadas ainda não existem.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-10-21-debate-ao-vivo DV-002 --baseline
//
// Cada teste roda `dotnet test --filter` (via TRX) e exige que cada método nomeado seja descoberto e passe;
// skip conta como falha. Integração exige FLUXO_TEST_POSTGRES (PostgreSQL 17 com pgvector) e, para o
// leitor de CPF, FIRESTORE_EMULATOR_HOST: sem ambiente o gate falha.
// Escopo: só DV-002. Timeline (DV-008), reprocessamento/relatório público (DV-009), handlers e UI ficam fora.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT, requireEnv, runDotnetClasses, runOk } from './dv-002-dotnet-helper.mjs';

const PG = 'PostgreSQL 17 descartável com pgvector';
const whole = (methods) => ({ methods, wholeClass: true });

// ── 2A schema ────────────────────────────────────────────────────────────────

test('DV-002 schema: enums wire = CHECK do SQL e constraints/triggers/FKs recusam dado inválido', () => {
  requireEnv('FLUXO_TEST_POSTGRES', PG);
  runDotnetClasses({
    DebateEnumsTests: whole([
      'Wire_values_match_sql_check_constraints',
      'Wire_values_round_trip',
    ]),
    DebateSchemaTests: whole([
      'Card_needs_human_constraint_rejects_validated_without_revision',
      'Hidden_states_constraint_rejects_public_revision',
      'Manual_after_validation_constraint_rejects_unvalidated_public_revision',
      'Validated_shows_validated_and_expired_has_time_constraints_reject_invalid_rows',
      'Validated_revision_requires_validate_action_trigger',
      'Revisions_and_editorial_actions_are_append_only',
      'Composite_fks_require_revision_of_same_fact_check',
      'Only_one_visible_fact_check_per_claim',
      'Mvp_sql_is_idempotent_and_matches_ef_migration',
      'Pgvector_sql_applies_with_and_without_extension',
    ]),
  });
});

test('DV-002 schema: migrator aplica debates-mvp.sql e debates-pgvector.sql na ordem e o contrato do migrator passa', () => {
  const sqlDir = path.join(ROOT, 'backend/deploy/sql');
  for (const f of ['debates-mvp.sql', 'debates-pgvector.sql', 'bootstrap-extensions.sql']) {
    assert.ok(fs.existsSync(path.join(sqlDir, f)), `SQL ausente: backend/deploy/sql/${f}`);
  }
  const entry = fs.readFileSync(path.join(ROOT, 'backend/deploy/migrator/entrypoint.sh'), 'utf8');
  const pos = (name) => entry.indexOf(name);
  assert.ok(pos('debates-mvp.sql') > pos('civic-events-mvp.sql') && pos('civic-events-mvp.sql') >= 0, 'debates-mvp.sql depois de civic-events-mvp.sql');
  assert.ok(pos('debates-pgvector.sql') > pos('debates-mvp.sql'), 'debates-pgvector.sql depois de debates-mvp.sql');
  assert.ok(pos('grant-runtime.sql') > pos('debates-pgvector.sql'), 'grant-runtime.sql por último');
  const contract = fs.readFileSync(path.join(ROOT, 'backend/deploy/migrator/test-entrypoint.sh'), 'utf8');
  assert.match(contract, /DebatesMvp/, 'test-entrypoint.sh deve conferir o history da migration DebatesMvp');
  assert.match(contract, /bootstrap-extensions\.sql/, 'test-entrypoint.sh deve aplicar bootstrap-extensions.sql antes do migrator');
  requireEnv('MIGRATOR_TEST_PASSWORD', 'PostgreSQL 17 descartável para o contrato do migrator');
  runOk('sh', ['backend/deploy/migrator/test-entrypoint.sh'], { label: 'test-entrypoint.sh', timeout: 110_000 });
});

// ── 2B máquinas de estado e bomba de outbox ──────────────────────────────────

test('DV-002 state-machine: transições do debate e da checagem, visibilidade e expiração no prazo de validação', () => {
  requireEnv('FLUXO_TEST_POSTGRES', PG);
  runDotnetClasses({
    DebateStateMachineTests: whole([
      'Allowed_transitions_follow_diagram',
      'Invalid_transition_returns_invalid_state',
      'Archive_without_revised_requires_skip_reason',
      'Is_test_changes_only_in_draft_or_scheduled',
    ]),
    DebateFactCheckStateMachineTests: whole([
      'Every_allowed_transition_sets_expected_pointers',
      'Transitions_outside_table_return_invalid_state',
      'Ai_never_reaches_validated',
      'Manual_never_becomes_balloon',
      'Hold_does_not_publish',
      'Pending_verdict_cannot_be_validated',
      'Visibility_resolves_balloon_card_or_absent',
    ]),
    DebateEndExpirationTests: whole([
      'End_keeps_pending_until_validation_window_closes',
      'Ai_draft_after_end_returns_debate_ended',
    ]),
  });
});

test('DV-002 outbox-pump: só debate.*, cadência 1 s/10 s, idempotência e sinal de timeline atômico', () => {
  requireEnv('FLUXO_TEST_POSTGRES', PG);
  runDotnetClasses({
    DebateOutboxPumpTests: whole([
      'Pump_processes_only_debate_messages',
      'Pump_polls_every_second_while_live_or_reprocessing',
      'Pump_polls_every_ten_seconds_otherwise',
      'Double_processing_with_idempotent_handler_does_not_fail',
      'Timeline_signal_increments_version_and_writes_outbox_atomically',
    ]),
  });
});

// ── 2D rotas internas do worker ──────────────────────────────────────────────

test('DV-002 internal-work: config, heartbeat, falas, lease, extrações, ai-draft e reuse-search', () => {
  requireEnv('FLUXO_TEST_POSTGRES', PG);
  runDotnetClasses({
    DebateInternalWorkTests: whole([
      'Ingestion_config_has_no_user_data',
      'Ingestion_status_returns_stop_after_admin_stop',
      'Utterances_are_idempotent_by_ingestion_and_seq',
      'Utterance_before_start_keeps_negative_offset',
      'Work_lease_only_delivers_utterances_with_confirmed_speaker',
      'Work_lease_never_gives_same_item_to_two_workers',
      'Renew_extends_and_rejects_expired_or_foreign_lease',
      'Extractions_auto_send_checkable_claims_with_confirmed_speaker',
      'Ai_draft_returns_documented_error_codes_and_writes_nothing',
      'Reuse_search_stores_embedding_and_returns_only_validated_same_is_test',
    ]),
  });
});

// ── 2C segurança ─────────────────────────────────────────────────────────────

test('DV-002 internal-auth: OIDC só em /internal, SA exata, fail-closed e worker fora de admin/leitor', () => {
  runDotnetClasses({
    DebateInternalAuthTests: whole([
      'Missing_token_returns_401',
      'Firebase_token_returns_401',
      'Other_service_account_returns_403',
      'Wrong_audience_returns_401',
      'Expired_token_returns_401',
      'Invalid_signature_returns_401',
      'Configured_service_account_succeeds',
      'Worker_token_is_rejected_on_admin_and_reader_routes',
      'Missing_configuration_returns_503',
    ]),
  });
});

test('DV-002 reader-cpf: GET /debates exige CPF verificado no servidor e esconde is_test/hidden', () => {
  requireEnv('FLUXO_TEST_POSTGRES', PG);
  requireEnv('FIRESTORE_EMULATOR_HOST', 'emulador Firestore descartável, banco fluxo');
  runDotnetClasses({
    DebateReaderAccessTests: whole([
      'Unverified_levels_return_403',
      'Verified_and_enhanced_return_200',
      'Test_and_hidden_debates_are_not_listed',
      'Unavailable_reader_returns_503',
      'Cache_does_not_keep_access_after_ttl',
    ]),
    PersonVerificationReaderTests: whole([
      'Reads_verification_level_from_person_profiles_in_fluxo_database',
    ]),
  });
});

test('DV-002 admin-permissions: .NET anyOf, implicação publish→review, legal sem debates.* e MFA recente', () => {
  requireEnv('FIRESTORE_EMULATOR_HOST', 'AdminAccessTests usa o emulador para o registry');
  runDotnetClasses({
    AdminAccessTests: {
      wholeClass: false,
      methods: [
        'Debates_publish_implies_debates_review_for_admin',
        'Legal_passes_legal_read_and_fails_every_debates_permission',
        'Primary_owner_passes_debates_permissions',
      ],
    },
    DebateAdminAuthorizationTests: whole([
      'Any_of_accepts_any_listed_permission',
      'Sensitive_writes_with_old_auth_time_return_reauth_required',
      'Operate_can_list_admin_debates',
      'Debate_reads_do_not_audit_and_writes_do',
    ]),
  });
});

test('DV-002 admin-permissions: Functions aceitam debates.*, publish implica review e legal fica sem debates.*', () => {
  runOk('npm', ['--prefix', 'functions', 'run', 'build'], { label: 'build das Functions' });
  const probe = spawnSync(process.execPath, ['-e', `
    const a = require('./functions/lib/admin/shared/admin');
    console.log(JSON.stringify({
      all: a.allAdminPermissions,
      publish: a.sanitizeAdminPermissions(['debates.publish']),
      legal: a.permissionsForRole('legal', ['debates.manage', 'debates.operate', 'debates.review', 'debates.publish', 'legal.read']),
      legalList: a.legalPermissions,
    }));
  `], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
  assert.equal(probe.status, 0, `não carregou functions/lib/admin/shared/admin:\n${probe.stderr}`);
  const out = JSON.parse(probe.stdout.trim().split('\n').pop());
  for (const p of ['debates.manage', 'debates.operate', 'debates.review', 'debates.publish']) {
    assert.ok(out.all.includes(p), `allAdminPermissions sem ${p}`);
  }
  assert.ok(out.publish.includes('debates.publish') && out.publish.includes('debates.review'), 'debates.publish deve implicar debates.review');
  assert.deepEqual(out.legal.filter((p) => p.startsWith('debates.')), [], 'legal não recebe debates.*');
  assert.deepEqual(out.legalList.filter((p) => p.startsWith('debates.')), [], 'legalPermissions não contém debates.*');

  const access = fs.readFileSync(path.join(ROOT, 'functions/src/admin/access.ts'), 'utf8');
  const schema = access.slice(access.indexOf('const permissionSchema'), access.indexOf('const reasonSchema'));
  for (const p of ['debates.manage', 'debates.operate', 'debates.review', 'debates.publish']) {
    assert.ok(schema.includes(`"${p}"`), `permissionSchema de access.ts sem ${p}`);
  }
  assert.match(access, /permissions:\s*z\.array\(permissionSchema\)\.max\(32\)/, 'saveAccessSchema deve aceitar até 32 permissões');
  runOk(process.execPath, ['--test', 'functions/test/admin_access_management.test.js'], { label: 'admin_access_management.test.js' });
});

test('DV-002 admin-permissions: admin-web aceita os quatro debates.* e recusa valor desconhecido', () => {
  const probe = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', '--input-type=module', '-e', `
    const m = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'admin-web/src/shared/domain/contracts.ts')).href)});
    const ok = (v) => m.adminPermissionSchema.safeParse(v).success;
    console.log(JSON.stringify({
      debates: ['debates.manage', 'debates.operate', 'debates.review', 'debates.publish'].map(ok),
      unknown: ok('debates.delete'),
    }));
  `], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
  assert.equal(probe.status, 0, `não carregou admin-web contracts.ts:\n${probe.stderr}`);
  const out = JSON.parse(probe.stdout.trim().split('\n').pop());
  assert.deepEqual(out.debates, [true, true, true, true], 'adminPermissionSchema deve aceitar os quatro debates.*');
  assert.equal(out.unknown, false, 'adminPermissionSchema deve recusar valor desconhecido');
  runOk('npx', ['vitest', 'run', 'src/shared/domain/contracts.test.ts'], {
    cwd: path.join(ROOT, 'admin-web'), env: { ...process.env, NODE_ENV: 'test' }, label: 'vitest contracts.test.ts',
  });
});

test('DV-002 admin-permissions: enums de debate registrados em CANONICAL_ENUMS com os quatro arquivos', async () => {
  const regras = await import(pathToFileURL(path.join(ROOT, '.claude/hooks/lib/regras.mjs')).href);
  const files = [
    'backend/src/Exemplo SaaS.Api/Modules/Debates/DebateEnums.cs',
    'admin-web/src/modules/debates/domain/enums.ts',
    'ofluxo_site/src/platform/domain/debate-enums.ts',
    'services/debate-worker/src/domain/debate-enums.ts',
  ];
  const names = [
    'DebateStatus', 'DebatePublicMode', 'ParticipantRole', 'UtteranceOrigin', 'ClaimType', 'ClaimStatus', 'Verdict',
    'FactCheckOrigin', 'FactCheckState', 'FactCheckValidationStatus', 'FactCheckDisplay', 'RevisionAuthorKind',
    'AnswerStatus', 'TimelineEventType', 'AudioSourceKind', 'IngestionState', 'AiPublication', 'WorkState', 'WorkKind',
    'AiRunPurpose', 'SourceKind', 'EditorialActionType', 'ChangeReasonCode', 'DiscardReasonCode', 'ReplyRequestState',
  ];
  for (const name of names) {
    assert.deepEqual([...(regras.CANONICAL_ENUMS[name] ?? [])].sort(), [...files].sort(), `CANONICAL_ENUMS.${name}`);
  }
  const outside = regras.checkContent('ofluxo_site/src/platform/pulso/outro.ts', 'export type Verdict = "true" | "false";');
  assert.ok(outside.avisos.some((a) => a.includes('Verdict')), 'redefinir Verdict fora dos arquivos canônicos deve avisar');
  const inside = regras.checkContent(files[0], 'public enum Verdict { True, False }');
  assert.deepEqual(inside.avisos, [], 'no arquivo canônico não há aviso');
  runOk(process.execPath, ['--test', '.claude/hooks/test/regras.test.mjs'], { label: 'regras.test.mjs' });
});

// ── 2E mesa ──────────────────────────────────────────────────────────────────

test('DV-002 desk: SSE multi-instância, upload assinado, ingestão e importação de candidatos', () => {
  requireEnv('FLUXO_TEST_POSTGRES', PG);
  runDotnetClasses({
    DebateDeskStreamTests: whole([
      'Last_event_id_resends_only_newer_events',
      'Id_outside_window_sends_snapshot',
      'Once_returns_and_closes',
      'Event_written_by_other_instance_reaches_stream',
      'Partial_has_no_id',
      'Desk_rate_limit_policy_is_separate_from_global',
    ]),
    DebateStorageTests: whole([
      'Upload_url_is_put_15_min_with_type_size_and_debate_prefix',
      'Invalid_content_type_returns_422',
      'Too_large_returns_413',
      'Audio_clip_expires_within_5_min_and_requires_review',
    ]),
    DebateIngestionTests: whole([
      'Start_calls_launcher_with_debate_and_source',
      'Start_without_audio_source_returns_409',
      'Device_source_does_not_call_launcher',
      'Stop_cancels_registered_execution',
    ]),
    DebateParticipantImportTests: whole([
      'Import_writes_only_number_ballot_name_and_party',
      'Extra_snapshot_fields_are_ignored',
      'Office_without_snapshot_returns_422',
    ]),
  });
});

// ── 2F editorial ─────────────────────────────────────────────────────────────

test('DV-002 editorial: revisão atual, duas pessoas, fontes, motivo, lock, manual e direito de resposta', () => {
  requireEnv('FLUXO_TEST_POSTGRES', PG);
  runDotnetClasses({
    DebateEditorialApiTests: whole([
      'Stale_revision_returns_409_with_latest_revision',
      'Two_person_required_when_author_validates',
      'Confirmation_then_validation_by_other_person_succeeds',
      'Unchecked_sources_return_422',
      'Changed_verdict_requires_reason',
      'Lock_held_blocks_other_users',
      'Not_validate_with_discard_and_manual_check',
      'Manual_check_hidden_until_validated',
      'Correct_and_unpublish_require_public_reason',
      'Patch_is_test_after_scheduled_returns_is_test_locked',
      'Reply_accept_requires_published_text_and_reject_requires_reason',
    ]),
  });
});
