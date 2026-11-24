// Gates FC-002 — kit de marca do Creator: enums, zero-hardcode, schema, contraste, paleta, validação de asset, SVG, upload
// por URL assinada, limite de templates, marca d'água, imutabilidade, isolamento, config aditivo, regressão do Debates e docs.
// ANTES da implementação cada gate DEVE falhar.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-11-14-fluxo-creator FC-002 --baseline
// .NET exige o SDK, FLUXO_TEST_POSTGRES e, para "negócio inexistente => 403", o emulador do Firestore (FIRESTORE_EMULATOR_HOST).
// Fora do eval (manual-pendente): upload real ao GCS com IamBlobSigner e bucket de verdade, CORS do navegador e `complete`
// lendo objeto real. Dependem do bucket (FC-016) e da infra (FC-007/FC-008).
// Convenções de leitura fixadas pelos templates (a spec descreve os campos): ver o cabeçalho de cada GateFc002*.cs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  APPSETTINGS, CREATOR_DIR, ROOT, assertEnumsEverywhere, exists, keyPaths, leaves, read, runDotnetGate, stripComments, walk,
} from './fc-gate-helper.mjs';

const SUPPORT = ['GateFc002Support.cs'];
const MIGRATIONS = 'backend/src/Exemplo SaaS.Api/Infrastructure/Persistence/Migrations';
const ENTRYPOINT = 'backend/deploy/migrator/entrypoint.sh';
const GRANTS = 'backend/deploy/sql/grant-runtime.sql';
const OPTIONS = `${CREATOR_DIR}/CreatorOptions.cs`;
const MODULE = [`${CREATOR_DIR}/CreatorBrandKitEndpoints.cs`];
const gate = (classes, options = {}) => runDotnetGate(classes, { byMethod: true, support: SUPPORT, postgres: true, ...options });

const WIRE = {
  CreatorAssetPurpose: ['template', 'watermark'],
  CreatorAssetStatus: ['pending', 'ready'],
  CreatorAssetFormat: ['jpeg', 'png', 'svg', 'webp'],
  CreatorPaletteRole: ['bg1', 'text1', 'bg2', 'text2', 'accent'],
  CreatorContrastLevel: ['good', 'warning', 'needs_confirmation'],
};

test('FC-002 enums: 5 enums novos com o wire exato em C#, TS e CANONICAL_ENUMS, sem redefinição no Flutter e nas Functions', async () => {
  await assertEnumsEverywhere(WIRE);
});

test('FC-002 zero-hardcode: limites, limiares de contraste, lado máximo e MIME só em CreatorOptions e appsettings', () => {
  const files = walk(CREATOR_DIR, (f) => f.endsWith('.cs') && !f.endsWith('/CreatorOptions.cs'));
  assert.ok(files.some((f) => f.endsWith('/CreatorBrandKitEndpoints.cs')), 'CreatorBrandKitEndpoints.cs ausente');
  const literals = /\b(4\.5|3\.0|4096|524288|5000|10485760|2000|0\.82|0\.12|0\.04|0\.90?)\b|"image\/(jpeg|png|webp|svg\+xml)"/;
  const offenders = files.filter((f) => literals.test(stripComments(read(f))));
  assert.deepEqual(offenders, [], 'limite, limiar ou MIME como literal fora de CreatorOptions.cs');
  const creator = JSON.parse(read(APPSETTINGS)).Creator ?? {};
  const paths = keyPaths(creator);
  for (const key of ['AssetBucket', 'Assets.UploadUrlMinutes', 'Assets.DownloadUrlMinutes', 'Assets.PendingTtlMinutes', 'Assets.PendingMaxPerBusiness',
    'Assets.MaxSidePx', 'Assets.ClientMaxSideFactor', 'Assets.ClientQuality', 'Assets.SvgMaxBytes', 'Assets.SvgMaxNodes', 'Assets.SvgMaxDepth',
    'Assets.TemplateNameMaxChars', 'Assets.FormatMimeTypes', 'Contrast.GoodMin', 'Contrast.WarningMin']) {
    assert.ok(paths.includes(key), `appsettings.json Creator sem ${key}`);
  }
  assert.equal(creator.AssetBucket, '', 'AssetBucket nasce vazio (503 até FC-016)');
  assert.deepEqual(
    [creator.Assets.UploadUrlMinutes, creator.Assets.DownloadUrlMinutes, creator.Assets.PendingTtlMinutes, creator.Assets.PendingMaxPerBusiness, creator.Assets.MaxSidePx,
      creator.Assets.ClientMaxSideFactor, creator.Assets.ClientQuality, creator.Assets.SvgMaxBytes, creator.Assets.SvgMaxNodes, creator.Assets.SvgMaxDepth,
      creator.Assets.TemplateNameMaxChars, creator.Contrast.GoodMin, creator.Contrast.WarningMin],
    [15, 5, 60, 20, 4096, 2, 0.82, 524288, 5000, 32, 80, 4.5, 3]);
  assert.deepEqual(creator.Assets.FormatMimeTypes, { jpeg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml', webp: 'image/webp' });
  assert.ok(leaves(creator).includes('image/svg+xml'));
  gate({ GateFc002AccessTests: ['Invalid_asset_or_contrast_ranges_stop_the_startup_citing_creator_keys'] }, { postgres: false, requiredFiles: [OPTIONS] });
});

test('FC-002 schema: migration EF e creator-brandkit.sql equivalentes e idempotentes, entrypoint antes do grant, 3 tabelas no grant', () => {
  assert.ok(exists('backend/deploy/sql/creator-brandkit.sql'), 'creator-brandkit.sql ausente');
  const migrations = walk(MIGRATIONS, (f) => /_CreatorBrandKit(\.Designer)?\.cs$/.test(f));
  assert.equal(migrations.length, 2, 'migration EF CreatorBrandKit (.cs e .Designer.cs) ausente');
  const stamp = path.basename(migrations[0]).slice(0, 14);
  assert.ok(stamp > '20261111214447', `migration anterior à última existente (${stamp})`);
  assert.match(read(`${MIGRATIONS}/Exemplo SaaSDbContextModelSnapshot.cs`), /creator_brand_kits/, 'snapshot do EF sem creator_brand_kits');
  const configurations = read('backend/src/Exemplo SaaS.Api/Infrastructure/Persistence/CreatorConfigurations.cs');
  assert.match(configurations, /creator-brandkit\.sql/, 'CreatorConfigurations.cs sem o apontamento para o espelho SQL');
  const entry = read(ENTRYPOINT);
  const own = entry.indexOf('apply_with_role "${SQL_DIR}/creator-brandkit.sql"');
  assert.ok(own > 0, 'entrypoint.sh não aplica creator-brandkit.sql');
  assert.ok(own < entry.indexOf('apply_with_role "${SQL_DIR}/grant-runtime.sql"'), 'creator-brandkit.sql precisa vir antes de grant-runtime.sql');
  const grants = read(GRANTS);
  for (const table of ['creator_assets', 'creator_templates', 'creator_brand_kits']) assert.match(grants, new RegExp(`fluxo\\.${table}\\b`), `grant-runtime.sql sem ${table}`);
  gate({ GateFc002SchemaTests: ['Migration_creates_three_tables_with_enum_checks_restrict_fk_and_no_business_fk', 'Sql_script_is_idempotent_and_produces_the_same_catalog_as_the_migration'] },
    { requiredFiles: [`${CREATOR_DIR}/Domain/CreatorBrandKit.cs`] });
});

test('FC-002 contraste: vetores WCAG, truncamento em 2 casas, limiares 4,5 e 3, papéis por quantidade de cores, sugestão e destaque informativo', () => {
  gate({
    GateFc002PaletteTests: ['Contrast_vectors_follow_wcag_with_two_decimal_truncation_and_the_thresholds', 'Roles_follow_the_color_count_and_the_accent_of_four_colors_is_the_text_of_pair_one',
      'Suggestion_reaches_the_good_level_by_changing_only_the_text_color', 'Accent_contrast_is_informational_and_never_blocks_the_save'],
  }, { requiredFiles: [`${CREATOR_DIR}/Domain/CreatorContrast.cs`, `${CREATOR_DIR}/Domain/CreatorPalette.cs`] });
});

test('FC-002 paleta-api: 1 e 6 cores, hex inválido, normalização, par abaixo de 3:1 exige confirmação e version sobe', () => {
  gate({
    GateFc002PaletteTests: ['Wrong_color_count_and_invalid_hex_give_422_creator_palette_invalid', 'Hex_is_normalized_to_uppercase_rrggbb',
      'Pair_under_three_to_one_needs_confirmation_and_warning_does_not', 'Get_returns_the_calculated_palette_and_every_write_bumps_the_version'],
  }, { requiredFiles: MODULE });
});

test('FC-002 asset-validacao: formato pelos bytes, MIME divergente, lado máximo, JPEG sem EXIF, truncado e complete idempotente', () => {
  gate({
    GateFc002AssetTests: ['Format_comes_from_the_bytes_and_dimensions_from_the_header', 'Declared_type_that_disagrees_with_the_bytes_is_422_creator_asset_invalid',
      'Side_above_the_ceiling_or_zero_is_422_creator_asset_dimensions_and_truncated_files_are_422', 'Side_ceiling_comes_from_configuration',
      'Jpeg_is_stored_without_exif_gps_or_data_after_the_end_of_image', 'Complete_is_idempotent_and_rejects_bytes_larger_than_declared'],
  }, { requiredFiles: [`${CREATOR_DIR}/Application/CreatorAssetInspector.cs`] });
});

test('FC-002 svg: corpus ativo recusado por inteiro, limites de nós/profundidade/bytes e logo legítimo reserializado', () => {
  gate({
    GateFc002AssetTests: ['Active_svg_content_is_rejected_whole_with_creator_svg_rejected', 'Oversized_or_too_deep_svg_is_rejected_and_the_limits_come_from_configuration',
      'Legit_logo_is_approved_and_reserialized_without_what_was_removed'],
  }, { requiredFiles: [`${CREATOR_DIR}/Application/SvgSanitizer.cs`] });
});

test('FC-002 upload-url: PUT com tipo e tamanho presos, expiração da configuração, caminho opaco, recusas, 503 e 429', () => {
  gate({
    GateFc002KitTests: ['Upload_url_is_a_put_with_pinned_type_size_expiry_and_an_opaque_staging_path', 'Invalid_upload_requests_are_refused_before_any_signature',
      'Empty_bucket_answers_503_creator_storage_unavailable', 'Pending_uploads_above_the_ceiling_answer_429_creator_uploads_pending'],
  }, { requiredFiles: [`${CREATOR_DIR}/Infrastructure/ICreatorAssetStorage.cs`] });
});

test('FC-002 limite-templates: 6 em paralelo com limite 3 cria exatamente 3, excluir libera a vaga e outra conta não é afetada', () => {
  gate({
    GateFc002KitTests: ['Parallel_template_creation_never_passes_the_limit_and_deleting_frees_a_slot', 'Template_position_grows_and_the_name_has_a_ceiling'],
  }, { requiredFiles: MODULE });
});

test('FC-002 marca-dagua: defaults da configuração, faixas, canto, purpose, WebP e SVG aceitos e DELETE limpa', () => {
  gate({
    GateFc002KitTests: ['Watermark_defaults_come_from_configuration_and_every_field_is_range_checked', 'Watermark_accepts_webp_and_svg_rejects_other_purposes_and_delete_clears_it'],
  }, { requiredFiles: MODULE });
});

test('FC-002 imutavel: replace e DELETE mantêm a linha do asset (retired_at) e nenhum objeto ready é apagado', () => {
  gate({ GateFc002KitTests: ['Replace_and_delete_keep_every_asset_row_and_never_delete_a_ready_object'] }, { requiredFiles: MODULE });
});

test('FC-002 templates-crud: GET /brand-kit com bytes economizados e prévia, PATCH com ponto focal e PUT /templates/order atômico', () => {
  gate({ GateFc002KitTests: ['Kit_lists_templates_with_sizes_preview_and_supports_patch_and_reorder'] }, { requiredFiles: MODULE });
});

test('FC-002 isolamento: 401, 403, editor e viewer só leem, owner e admin escrevem, recurso alheio dá 404 e nada sensível vaza', () => {
  gate({
    GateFc002AccessTests: ['Anonymous_gets_401_and_strangers_and_unknown_businesses_get_403', 'Editor_and_viewer_read_but_cannot_write_while_owner_and_admin_write',
      'Assets_and_templates_of_another_business_answer_404_never_403', 'Responses_never_carry_uid_email_document_bucket_or_storage_paths'],
  }, { requiredFiles: MODULE });
});

test('FC-002 config-aditivo: /config expõe limits.assets, limits.contrast e 4 enums novos, e o contrato do FC-001 segue verde', () => {
  gate({
    GateFc002AccessTests: ['Config_exposes_asset_and_contrast_limits_and_the_four_new_enums_additively'],
    GateFc001ApiTests: ['Payload_carries_every_limit_viewport_and_enum_from_the_spec', 'Response_never_exposes_document_or_email_fields'],
  }, { requiredFiles: MODULE });
});

test('FC-002 regressao-debate: assinatura V4 extraída para Infrastructure/Storage e DebateStorageTests inteiro verde', () => {
  const signer = 'backend/src/Exemplo SaaS.Api/Infrastructure/Storage/GcsV4UrlSigner.cs';
  assert.ok(exists(signer), 'GcsV4UrlSigner.cs ausente (decisão D4)');
  assert.match(read(signer), /GOOG4-RSA-SHA256/, 'o signer extraído deve conter a assinatura V4');
  const debates = read('backend/src/Exemplo SaaS.Api/Modules/Debates/DebateAudioStorage.cs');
  assert.doesNotMatch(debates, /GOOG4-RSA-SHA256/, 'GcsDebateAudioStorage deve delegar ao signer, sem duplicar a criptografia');
  assert.match(debates, /GcsV4UrlSigner/, 'GcsDebateAudioStorage não delega ao GcsV4UrlSigner');
  const creatorCode = walk(CREATOR_DIR, (f) => f.endsWith('.cs')).map((f) => read(f)).join('\n');
  assert.doesNotMatch(creatorCode, /GOOG4-RSA-SHA256/, 'o Creator não pode duplicar a assinatura V4');
  assert.match(creatorCode, /GcsV4UrlSigner/, 'o storage do Creator deve usar o GcsV4UrlSigner');
  runDotnetGate({}, {
    postgres: true,
    existing: ['DebateStorageTests.Upload_url_is_put_15_min_with_type_size_and_debate_prefix', 'DebateStorageTests.Invalid_content_type_returns_422',
      'DebateStorageTests.Too_large_returns_413', 'DebateStorageTests.Audio_clip_expires_within_5_min_and_requires_review'],
  });
});

test('FC-002 docs: README com a seção FC-002, ponteiro no desenho e artefatos de deploy atualizados', () => {
  assert.match(read('backend/README.md'), /^#+ .*Creator.*FC-002/m, 'backend/README.md sem a seção "Creator — FC-002 (kit de marca)"');
  assert.match(read('docs/parking-lot/fluxo-creator.md'), /FC-002/, 'desenho sem o ponteiro "Kit de marca implementado em FC-002"');
  assert.ok(exists('backend/deploy/sql/creator-brandkit.sql'), 'creator-brandkit.sql ausente');
  assert.match(read(ENTRYPOINT), /creator-brandkit\.sql/);
  assert.match(read(GRANTS), /fluxo\.creator_brand_kits/);
  assert.match(read('backend/README.md'), /creator_template_limit/, 'README sem o aviso de que creator_template_limit vem da configuração');
  assert.ok(fs.existsSync(path.join(ROOT, '.claude/hooks/lib/regras.mjs')));
});
