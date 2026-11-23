// Gate FC-002-SCHEMA (template): migration EF e backend/deploy/sql/creator-brandkit.sql dizem a mesma coisa.
// A: banco de testes migrado pelo EF. B: banco descartável vazio com só o schema fluxo e o histórico, onde o SQL roda duas vezes.
using Npgsql;

namespace Fluxo.Api.Tests;

public sealed class GateFc002SchemaTests
{
    private static readonly string[] Tables = ["creator_assets", "creator_templates", "creator_brand_kits"];

    private static async Task<string?> ErrorAsync(string connection, string sql)
    {
        try { await DebateTestDb.ExecAsync(connection, sql); return null; }
        catch (PostgresException e) { return $"{e.SqlState}:{e.ConstraintName}"; }
    }

    private static string InsertAsset(string business, string purpose = "template", string status = "pending", string? format = null, string? objectPath = null) =>
        $"""
        INSERT INTO fluxo.creator_assets (id, business_id, purpose, status, format, declared_content_type, safe_file_name, staging_path, object_path, size_bytes, created_by_uid, created_at)
        VALUES (gen_random_uuid(), '{business}', '{purpose}', '{status}', {(format is null ? "NULL" : $"'{format}'")}, 'image/png', 'a.png', 'staging/creator/{Guid.NewGuid():N}',
                {(objectPath is null ? "NULL" : $"'{objectPath}'")}, 10, 'uid', now())
        """;

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Migration_creates_three_tables_with_enum_checks_restrict_fk_and_no_business_fk()
    {
        await DebateTestDb.EnsureAsync();
        var c = DebateTestDb.Connection;
        foreach (var table in Tables)
            Assert.Equal("1", (await DebateTestDb.ScalarAsync<long>(c, $"SELECT count(*) FROM information_schema.tables WHERE table_schema='fluxo' AND table_name='{table}'")).ToString());
        var business = $"schema-{Guid.NewGuid():N}";

        Assert.Null(await ErrorAsync(c, InsertAsset(business)));
        Assert.StartsWith("23514", await ErrorAsync(c, InsertAsset(business, purpose: "banner")));
        Assert.StartsWith("23514", await ErrorAsync(c, InsertAsset(business, status: "weird")));
        Assert.StartsWith("23514", await ErrorAsync(c, InsertAsset(business, status: "ready", format: "gif", objectPath: $"creator/assets/{Guid.NewGuid():N}.gif")));
        var path = $"creator/assets/{Guid.NewGuid():N}.png";
        Assert.Null(await ErrorAsync(c, InsertAsset(business, status: "ready", format: "png", objectPath: path)));
        Assert.StartsWith("23505", await ErrorAsync(c, InsertAsset(business, status: "ready", format: "png", objectPath: path)));

        var asset = await DebateTestDb.ScalarAsync<Guid>(c, $"SELECT id FROM fluxo.creator_assets WHERE object_path = '{path}'");
        string Template(string preset = "feed_square", string focal = "0.5") =>
            $"INSERT INTO fluxo.creator_templates (id, business_id, asset_id, viewport_preset, focal_x, focal_y, position, created_at, updated_at) VALUES (gen_random_uuid(), '{business}', '{asset}', '{preset}', {focal}, 0.5, 0, now(), now())";
        Assert.Null(await ErrorAsync(c, Template()));
        Assert.StartsWith("23514", await ErrorAsync(c, Template(preset: "link_card")));
        Assert.StartsWith("23514", await ErrorAsync(c, Template(focal: "1.5")));
        Assert.StartsWith("23503", await ErrorAsync(c, $"DELETE FROM fluxo.creator_assets WHERE id = '{asset}'"));
        Assert.StartsWith("23503", await ErrorAsync(c, Template().Replace(asset.ToString(), Guid.NewGuid().ToString())));

        Assert.Equal("r", await DebateTestDb.ScalarAsync<string>(c, "SELECT confdeltype::text FROM pg_constraint WHERE contype='f' AND conrelid='fluxo.creator_templates'::regclass AND confrelid='fluxo.creator_assets'::regclass"));
        Assert.Equal(0L, await DebateTestDb.ScalarAsync<long>(c, "SELECT count(*) FROM pg_constraint WHERE contype='f' AND confrelid='fluxo.businesses'::regclass AND conrelid IN ('fluxo.creator_assets'::regclass,'fluxo.creator_templates'::regclass,'fluxo.creator_brand_kits'::regclass)"));
        Assert.Equal(0L, await DebateTestDb.ScalarAsync<long>(c, "SELECT count(*) FROM pg_trigger WHERE tgrelid='fluxo.creator_templates'::regclass AND NOT tgisinternal"));
        Assert.Equal("varchar-128", await DebateTestDb.ScalarAsync<string>(c, "SELECT 'varchar-' || character_maximum_length FROM information_schema.columns WHERE table_schema='fluxo' AND table_name='creator_assets' AND column_name='business_id'"));

        var kit = $"INSERT INTO fluxo.creator_brand_kits (business_id, updated_by_uid, created_at, updated_at) VALUES ('{business}', 'uid', now(), now())";
        Assert.Null(await ErrorAsync(c, kit));
        Assert.StartsWith("23505", await ErrorAsync(c, kit));
        Assert.Equal(1, await DebateTestDb.ScalarAsync<int>(c, $"SELECT version FROM fluxo.creator_brand_kits WHERE business_id='{business}'"));
        Assert.StartsWith("23514", await ErrorAsync(c, $"UPDATE fluxo.creator_brand_kits SET watermark_corner = 'center' WHERE business_id='{business}'"));
        Assert.StartsWith("23514", await ErrorAsync(c, $"UPDATE fluxo.creator_brand_kits SET palette = ARRAY(SELECT '#000000' FROM generate_series(1,21)) WHERE business_id='{business}'"));
        Assert.Null(await ErrorAsync(c, $"UPDATE fluxo.creator_brand_kits SET watermark_corner = 'top_left', palette = ARRAY['#FFFFFF','#000000'] WHERE business_id='{business}'"));
        Assert.True((await DebateTestDb.ScalarAsync<long>(c, "SELECT count(*) FROM pg_indexes WHERE schemaname='fluxo' AND tablename='creator_assets' AND indexdef ILIKE '%business_id%status%created_at%'")) >= 1, "índice (business_id, status, created_at) ausente");
        Assert.True((await DebateTestDb.ScalarAsync<long>(c, "SELECT count(*) FROM pg_indexes WHERE schemaname='fluxo' AND tablename='creator_templates' AND indexdef ILIKE '%business_id%position%' AND indexdef ILIKE '%deleted_at IS NULL%'")) >= 1, "índice parcial (business_id, position) WHERE deleted_at IS NULL ausente");
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Sql_script_is_idempotent_and_produces_the_same_catalog_as_the_migration()
    {
        await DebateTestDb.EnsureAsync();
        // Gate corrigido: o helper faz $"{prefix}_{guid:N}"[..40]; prefixo curto ("fcbk") estourava o corte. Prefixo >= 8 caracteres.
        var scratch = await DebateTestDb.CreateScratchDatabaseAsync("fcbrandkit");
        try
        {
            await DebateTestDb.ExecAsync(scratch, "CREATE SCHEMA fluxo; CREATE TABLE fluxo.\"__EFMigrationsHistory\" (\"MigrationId\" character varying(150) NOT NULL PRIMARY KEY, \"ProductVersion\" character varying(32) NOT NULL);");
            var sql = DebateTestDb.Sql("creator-brandkit.sql");
            await DebateTestDb.ExecAsync(scratch, sql);
            await DebateTestDb.ExecAsync(scratch, sql);
            var fromMigration = await GateFc.CatalogAsync(DebateTestDb.Connection, Tables);
            var fromSql = await GateFc.CatalogAsync(scratch, Tables);
            Assert.Equal(fromMigration, fromSql);
            Assert.Contains("creator_templates|con ", fromSql);
            var history = await DebateTestDb.ScalarAsync<string>(scratch, "SELECT string_agg(\"MigrationId\", ',') FROM fluxo.\"__EFMigrationsHistory\" WHERE \"MigrationId\" LIKE '%CreatorBrandKit%'");
            Assert.NotNull(history);
            Assert.DoesNotContain(',', history!);
            Assert.Equal(history, await DebateTestDb.ScalarAsync<string>(DebateTestDb.Connection, "SELECT \"MigrationId\" FROM fluxo.\"__EFMigrationsHistory\" WHERE \"MigrationId\" LIKE '%CreatorBrandKit%'"));
            Assert.Equal(1L, await DebateTestDb.ScalarAsync<long>(scratch, "SELECT count(*) FROM fluxo.\"__EFMigrationsHistory\" WHERE \"MigrationId\" LIKE '%CreatorBrandKit%'"));
        }
        finally
        {
            await DebateTestDb.DropScratchDatabaseAsync(scratch);
        }
    }
}
