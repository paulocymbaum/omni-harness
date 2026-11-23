// Gate BIL-002-ESQUEMA-ESPELHO. Template do autor de gates. Prova com o catálogo do PostgreSQL, sem depender de propriedades C#.
using Microsoft.EntityFrameworkCore;

namespace Fluxo.Api.Tests;

public sealed class GateBil002SchemaTests
{
    private static readonly string[] Tables =
    [
        "billing_products", "billing_prices", "billing_entitlement_specs", "billing_customers",
        "billing_subscriptions", "billing_invoices", "billing_charges", "billing_audit_events",
    ];

    private const string Filter = "c.relname LIKE 'billing%'";

    // Tabelas, colunas (tipo, nulidade, default), constraints e índices das tabelas billing_*.
    private static readonly string[] Catalog =
    [
        $"SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='fluxo' AND c.relkind='r' AND {Filter} ORDER BY 1",
        $"""
        SELECT c.relname||'.'||a.attname||' '||format_type(a.atttypid,a.atttypmod)||' '||a.attnotnull::text||' '||coalesce(pg_get_expr(d.adbin,d.adrelid),'')
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE n.nspname='fluxo' AND c.relkind='r' AND {Filter} AND a.attnum>0 AND NOT a.attisdropped ORDER BY 1
        """,
        $"""
        SELECT c.relname||' '||k.conname||' '||pg_get_constraintdef(k.oid) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='fluxo' AND {Filter} ORDER BY 1
        """,
        "SELECT indexname||' '||indexdef FROM pg_indexes WHERE schemaname='fluxo' AND tablename LIKE 'billing%' ORDER BY 1",
    ];

    private static async Task<IReadOnlyList<string>> ColumnsAsync(string table, string column) => await GateBil.RowsAsync(GateBil.C, $"""
        SELECT data_type||' '||coalesce(character_maximum_length::text,'')||' '||is_nullable FROM information_schema.columns
        WHERE table_schema='fluxo' AND table_name='{table}' AND column_name='{column}'
        """);

    private static async Task AssertCheckAsync(string table, params string[] values)
    {
        var checks = await GateBil.RowsAsync(GateBil.C, $"""
            SELECT pg_get_constraintdef(k.oid) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='fluxo' AND c.relname='{table}' AND k.contype='c'
            """);
        Assert.True(checks.Any(check => values.All(v => check.Contains($"'{v}'"))), $"{table} sem CHECK com {string.Join('|', values)}");
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Migration_creates_foundation_tables_and_leaves_out_excluded_ones()
    {
        await DebateTestDb.EnsureAsync();
        var existing = await GateBil.RowsAsync(GateBil.C, Catalog[0]);
        Assert.Empty(Tables.Except(existing));
        Assert.DoesNotContain("billing_subscription_items", existing);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Duplicate_live_subscription_is_blocked_by_partial_unique_index()
    {
        await DebateTestDb.EnsureAsync();
        var index = Assert.Single(await GateBil.RowsAsync(GateBil.C,
            "SELECT indexdef FROM pg_indexes WHERE schemaname='fluxo' AND indexname='ux_billing_subscriptions_active_customer'"));
        Assert.Contains("UNIQUE", index);
        Assert.Contains("customer_id", index);
        foreach (var status in new[] { "incomplete", "trialing", "active", "past_due", "paused", "pending_cancellation" })
            Assert.Contains($"'{status}'", index);
        Assert.DoesNotContain("'canceled'", index);
        Assert.DoesNotContain("'incomplete_expired'", index);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Every_enum_column_has_a_check_constraint()
    {
        await DebateTestDb.EnsureAsync();
        await AssertCheckAsync("billing_subscriptions", "incomplete", "incomplete_expired", "trialing", "active", "past_due", "paused", "pending_cancellation", "canceled");
        await AssertCheckAsync("billing_subscriptions", "manual", "pix_manual", "pix_automatico");
        await AssertCheckAsync("billing_invoices", "draft", "open", "paid", "void", "uncollectible", "refunded");
        await AssertCheckAsync("billing_charges", "pending", "paid", "failed", "expired", "refund_pending", "refunded", "chargeback");
        await AssertCheckAsync("billing_customers", "person", "business", "artist", "collective");
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Subject_has_no_foreign_key_and_is_unique_per_type_and_id()
    {
        await DebateTestDb.EnsureAsync();
        Assert.Equal("character varying 128 NO", Assert.Single(await ColumnsAsync("billing_customers", "subject_id")));
        var indexes = await GateBil.RowsAsync(GateBil.C, "SELECT indexdef FROM pg_indexes WHERE schemaname='fluxo' AND tablename='billing_customers'");
        Assert.Contains(indexes, i => i.Contains("UNIQUE") && i.Contains("(subject_type, subject_id)"));
        var foreignKeys = await GateBil.RowsAsync(GateBil.C, """
            SELECT pg_get_constraintdef(k.oid) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
            WHERE c.relname='billing_customers' AND k.contype='f'
            """);
        Assert.DoesNotContain(foreignKeys, f => f.Contains("subject_id"));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Customer_is_born_with_nullable_fiscal_columns()
    {
        await DebateTestDb.EnsureAsync();
        foreach (var column in new[] { "tax_id_ciphertext", "tax_id_hmac", "tax_id_mask", "external_customer_id" })
            Assert.EndsWith("YES", Assert.Single(await ColumnsAsync("billing_customers", column)));
        Assert.Empty(await ColumnsAsync("billing_customers", "tax_id"));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Money_is_stored_in_bigint_cents_and_never_as_float()
    {
        await DebateTestDb.EnsureAsync();
        var cents = await GateBil.RowsAsync(GateBil.C, """
            SELECT data_type FROM information_schema.columns WHERE table_schema='fluxo' AND table_name LIKE 'billing%' AND column_name LIKE '%cents%'
            """);
        Assert.NotEmpty(cents);
        Assert.All(cents, type => Assert.Equal("bigint", type));
        Assert.Empty(await GateBil.RowsAsync(GateBil.C, """
            SELECT column_name FROM information_schema.columns WHERE table_schema='fluxo' AND table_name LIKE 'billing%'
            AND data_type IN ('double precision','real')
            """));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Mvp_sql_is_idempotent_matches_ef_migration_and_seeds_inactive_paid_plans()
    {
        await using var probe = DebateTestDb.Context();
        var all = probe.Database.GetMigrations().ToList();
        var position = all.FindIndex(m => m.EndsWith("_BillingFoundation", StringComparison.Ordinal));
        Assert.True(position > 0, "migration <ts>_BillingFoundation ausente");
        var ef = await DebateTestDb.CreateScratchDatabaseAsync("bil002_ef");
        var sql = await DebateTestDb.CreateScratchDatabaseAsync("bil002_sql");
        try
        {
            foreach (var db in new[] { ef, sql }) await DebateTestDb.InstallVectorAsync(db);
            await DebateTestDb.MigrateToAsync(ef, all[position]);
            await DebateTestDb.MigrateToAsync(sql, all[position - 1]);
            for (var i = 0; i < 2; i++) await DebateTestDb.ExecAsync(sql, DebateTestDb.Sql("billing-mvp.sql"));
            foreach (var query in Catalog) Assert.Equal(await GateBil.RowsAsync(ef, query), await GateBil.RowsAsync(sql, query));
            Assert.Equal(1L, await DebateTestDb.ScalarAsync<long>(sql, $"""SELECT count(*) FROM fluxo."__EFMigrationsHistory" WHERE "MigrationId"='{all[position]}'"""));

            var products = await GateBil.RowsAsync(sql, "SELECT to_jsonb(p)::text FROM fluxo.billing_products p");
            Assert.Equal(4, products.Count);
            Assert.Contains(products, p => p.Contains("\"presenca\"") && p.Contains("\"active\": true"));
            foreach (var plan in new[] { "local", "pro", "rede" })
                Assert.Contains(products, p => p.Contains($"\"{plan}\"") && p.Contains("\"active\": false"));
            var prices = await GateBil.RowsAsync(sql, "SELECT to_jsonb(p)::text FROM fluxo.billing_prices p");
            Assert.Contains(prices, p => p.Contains("19900"));
            Assert.All(prices, p => Assert.Contains("\"trial_days\": 0", p));
            Assert.Equal(0L, await DebateTestDb.ScalarAsync<long>(sql, "SELECT count(*) FROM fluxo.billing_entitlement_specs"));
        }
        finally
        {
            await DebateTestDb.DropScratchDatabaseAsync(ef);
            await DebateTestDb.DropScratchDatabaseAsync(sql);
        }
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Runtime_role_only_reads_and_appends_billing_audit_events()
    {
        var db = await DebateTestDb.CreateScratchDatabaseAsync("bil002_grant");
        try
        {
            await DebateTestDb.InstallVectorAsync(db);
            await using (var context = DebateTestDb.Context(db)) await context.Database.MigrateAsync();
            await DebateTestDb.ExecAsync(db, """
                DO $r$ BEGIN
                  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='fluxo_api_runtime') THEN CREATE ROLE fluxo_api_runtime NOLOGIN; END IF;
                  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='fluxo_migrator_runtime') THEN CREATE ROLE fluxo_migrator_runtime NOLOGIN; END IF;
                END $r$;
                """);
            var name = new Npgsql.NpgsqlConnectionStringBuilder(db).Database!;
            await DebateTestDb.ExecAsync(db, DebateTestDb.Sql("grant-runtime.sql").Replace(":\"DBNAME\"", $"\"{name}\"", StringComparison.Ordinal));
            async Task<bool> Can(string table, string privilege) =>
                await DebateTestDb.ScalarAsync<bool>(db, $"SELECT has_table_privilege('fluxo_api_runtime','fluxo.{table}','{privilege}')");
            Assert.True(await Can("billing_audit_events", "SELECT"));
            Assert.True(await Can("billing_audit_events", "INSERT"));
            Assert.False(await Can("billing_audit_events", "UPDATE"));
            Assert.False(await Can("billing_audit_events", "DELETE"));
            foreach (var table in Tables.Except(["billing_audit_events"]))
                Assert.True(await Can(table, "SELECT"), $"grant-runtime.sql sem {table}");
        }
        finally { await DebateTestDb.DropScratchDatabaseAsync(db); }
    }
}
