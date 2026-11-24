// Gates FC-004-SCHEMA, FC-004-SQL-PARIDADE e FC-004-GRANTS (template). Só SQL contra o PostgreSQL de teste (nada do módulo é chamado).
// A: banco de testes migrado pelo EF. B: banco vazio com só fluxo.businesses e o histórico, onde creator-jobs.sql roda duas vezes.
using Npgsql;

namespace Fluxo.Api.Tests;

public sealed class GateFc004SchemaTests
{
    private const string Worker = "fluxo_creator_worker_runtime";

    private static string Job(string business, string kind = "strategy", string lane = "llm", int priority = 1, string status = "queued", string? extraColumns = null,
        string? extraValues = null, string? key = null, string? dedupe = null, string payload = "{}") =>
        $"""
        INSERT INTO fluxo.creator_jobs (id, business_id, project_id, kind, lane, priority, status, deadline_seconds, expires_at, idempotency_key, dedupe_key, payload{extraColumns})
        VALUES (gen_random_uuid(), '{business}', gen_random_uuid(), '{kind}', '{lane}', {priority}, '{status}', 120, now() + interval '15 minutes', '{key ?? Guid.NewGuid().ToString("N")}',
                {(dedupe is null ? "NULL" : $"'{dedupe}'")}, '{payload}'::jsonb{extraValues})
        """;

    private static async Task<string?> ConstraintAsync(string sql)
    {
        try { await DebateTestDb.ExecAsync(DebateTestDb.Connection, sql); return null; }
        catch (PostgresException e) { return e.ConstraintName ?? e.SqlState; }
    }

    private static async Task<string> BusinessAsync()
    {
        var (id, _) = await GateFc.SeedBusinessAsync();
        return id;
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Table_columns_checks_and_indexes_match_the_contract_and_invalid_rows_hit_the_right_constraint()
    {
        await DebateTestDb.EnsureAsync();
        var c = DebateTestDb.Connection;
        var columns = (await GateFc.CatalogAsync(c, "creator_jobs")).Split('\n').Where(l => l.Contains("|col ")).Select(l => l.Split("|col ")[1]).ToArray();
        string[] expected =
        [
            "id uuid", "business_id character varying(128)", "project_id uuid", "slide_index smallint", "kind character varying(32)", "lane character varying(16)",
            "priority smallint", "status character varying(32)", "attempts smallint", "max_attempts smallint", "run_after timestamp with time zone", "locked_by character varying(128)",
            "locked_until timestamp with time zone", "deadline_seconds smallint", "deadline_at timestamp with time zone", "expires_at timestamp with time zone",
            "idempotency_key character varying(200)", "dedupe_key character varying(200)", "payload jsonb", "result_ref character varying(2048)", "error_code character varying(64)",
            "first_started_at timestamp with time zone", "finished_at timestamp with time zone", "created_at timestamp with time zone", "updated_at timestamp with time zone",
        ];
        foreach (var column in expected) Assert.True(columns.Any(l => l.StartsWith(column + " ", StringComparison.Ordinal)), $"coluna ausente ou com tipo errado: {column}");
        Assert.Equal(expected.Length, columns.Length);
        string Nullable(string name) => columns.Single(l => l.StartsWith(name + " ", StringComparison.Ordinal)).Split(' ').First(p => p is "true" or "false");
        foreach (var notNull in new[] { "business_id", "project_id", "kind", "lane", "priority", "status", "attempts", "max_attempts", "run_after", "deadline_seconds", "expires_at", "idempotency_key", "payload", "created_at", "updated_at" })
            Assert.True(Nullable(notNull) == "true", $"{notNull} deve ser NOT NULL");
        foreach (var nullable in new[] { "slide_index", "locked_by", "locked_until", "deadline_at", "dedupe_key", "result_ref", "error_code", "first_started_at", "finished_at" })
            Assert.True(Nullable(nullable) == "false", $"{nullable} deve ser nulo");
        Assert.Contains(columns, l => l.StartsWith("status ") && l.Contains("'queued'"));
        Assert.Contains(columns, l => l.StartsWith("attempts ") && l.EndsWith(" 0"));
        Assert.Contains(columns, l => l.StartsWith("max_attempts ") && l.EndsWith(" 3"));

        var constraints = await DebateTestDb.ScalarAsync<string>(c, "SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'fluxo.creator_jobs'::regclass");
        foreach (var name in new[] { "pk_creator_jobs", "fk_creator_jobs_businesses", "ck_creator_jobs_status", "ck_creator_jobs_lane", "ck_creator_jobs_kind", "ck_creator_jobs_lane_kind",
            "ck_creator_jobs_priority", "ck_creator_jobs_running_has_lease", "ck_creator_jobs_queued_has_no_lease", "ck_creator_jobs_terminal_has_finished_at" })
            Assert.Contains(name, constraints!);
        Assert.True((await DebateTestDb.ScalarAsync<long>(c, "SELECT count(*) FROM pg_constraint WHERE conrelid = 'fluxo.creator_jobs'::regclass AND contype = 'c'")) >= 11, "faltam CHECKs (attempts, max_attempts, slide_index, payload)");
        Assert.Equal("c", await DebateTestDb.ScalarAsync<string>(c, "SELECT confdeltype::text FROM pg_constraint WHERE conname = 'fk_creator_jobs_businesses'"));
        var indexes = await DebateTestDb.ScalarAsync<string>(c, "SELECT string_agg(indexname, ',' ORDER BY indexname) FROM pg_indexes WHERE schemaname='fluxo' AND tablename='creator_jobs'");
        foreach (var name in new[] { "ix_creator_jobs_claim", "ix_creator_jobs_running_business", "ix_creator_jobs_lease", "ix_creator_jobs_queued_expiry", "ix_creator_jobs_project",
            "ux_creator_jobs_idempotency", "ux_creator_jobs_dedupe_queued" })
            Assert.Contains(name, indexes!);
        foreach (var partial in new[] { "ix_creator_jobs_claim", "ix_creator_jobs_running_business", "ix_creator_jobs_lease", "ix_creator_jobs_queued_expiry", "ux_creator_jobs_dedupe_queued" })
            Assert.Contains("WHERE", await DebateTestDb.ScalarAsync<string>(c, $"SELECT indexdef FROM pg_indexes WHERE indexname = '{partial}'") ?? "");

        var business = await BusinessAsync();
        Assert.Null(await ConstraintAsync(Job(business)));
        Assert.Null(await DebateTestDb.ScalarAsync<object>(c, $"SELECT deadline_at FROM fluxo.creator_jobs WHERE business_id='{business}'"));
        Assert.Equal("ck_creator_jobs_lane_kind", await ConstraintAsync(Job(business, kind: "strategy", lane: "render")));
        Assert.Equal("ck_creator_jobs_lane_kind", await ConstraintAsync(Job(business, kind: "adapt_viewport", lane: "llm")));
        Assert.Null(await ConstraintAsync(Job(business, kind: "adapt_viewport", lane: "render", priority: 2)));
        Assert.Equal("ck_creator_jobs_kind", await ConstraintAsync(Job(business, kind: "magic", lane: "llm")));
        Assert.Equal("ck_creator_jobs_lane", await ConstraintAsync(Job(business, kind: "strategy", lane: "gpu")));
        Assert.Equal("ck_creator_jobs_priority", await ConstraintAsync(Job(business, priority: 3)));
        Assert.Equal("ck_creator_jobs_status", await ConstraintAsync(Job(business, status: "weird")));
        Assert.Equal("ck_creator_jobs_running_has_lease", await ConstraintAsync(Job(business, status: "running")));
        Assert.Null(await ConstraintAsync(Job(business, status: "running", extraColumns: ", locked_by, locked_until", extraValues: ", 'w1', now() + interval '1 minute'")));
        Assert.Equal("ck_creator_jobs_queued_has_no_lease", await ConstraintAsync(Job(business, extraColumns: ", locked_by, locked_until", extraValues: ", 'w1', now() + interval '1 minute'")));
        Assert.Equal("ck_creator_jobs_terminal_has_finished_at", await ConstraintAsync(Job(business, status: "done")));
        Assert.Null(await ConstraintAsync(Job(business, status: "expired", extraColumns: ", finished_at", extraValues: ", now()")));
        Assert.StartsWith("ck_creator_jobs_", await ConstraintAsync(Job(business, extraColumns: ", attempts, max_attempts", extraValues: ", 4, 3")) ?? "");
        Assert.StartsWith("ck_creator_jobs_", await ConstraintAsync(Job(business, extraColumns: ", max_attempts", extraValues: ", 11")) ?? "");
        Assert.StartsWith("ck_creator_jobs_", await ConstraintAsync(Job(business, extraColumns: ", slide_index", extraValues: ", -1")) ?? "");
        Assert.StartsWith("ck_creator_jobs_", await ConstraintAsync(Job(business, payload: "{\"p\":\"" + new string('x', 70000) + "\"}")) ?? "");
        Assert.Null(await ConstraintAsync(Job(business, payload: "{\"p\":\"" + new string('x', 60000) + "\"}")));
        Assert.Equal("fk_creator_jobs_businesses", await ConstraintAsync(Job($"nao-existe-{Guid.NewGuid():N}")));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Idempotency_and_dedupe_keys_are_unique_where_the_contract_says_and_businesses_cascade()
    {
        await DebateTestDb.EnsureAsync();
        var c = DebateTestDb.Connection;
        var (business, other) = (await BusinessAsync(), await BusinessAsync());
        var key = $"k-{Guid.NewGuid():N}";
        Assert.Null(await ConstraintAsync(Job(business, key: key)));
        Assert.Equal("ux_creator_jobs_idempotency", await ConstraintAsync(Job(other, key: key)));
        var dedupe = $"d-{Guid.NewGuid():N}";
        Assert.Null(await ConstraintAsync(Job(business, dedupe: dedupe)));
        Assert.Equal("ux_creator_jobs_dedupe_queued", await ConstraintAsync(Job(business, dedupe: dedupe)));
        Assert.Null(await ConstraintAsync(Job(business, status: "cancelled", dedupe: dedupe, extraColumns: ", finished_at", extraValues: ", now()")));
        await DebateTestDb.ExecAsync(c, $"UPDATE fluxo.creator_jobs SET status='running', locked_by='w', locked_until=now()+interval '1 minute' WHERE dedupe_key='{dedupe}' AND status='queued'");
        Assert.Null(await ConstraintAsync(Job(business, dedupe: dedupe)));
        await DebateTestDb.ExecAsync(c, $"DELETE FROM fluxo.businesses WHERE id = '{other}'");
        Assert.Equal(0L, await DebateTestDb.ScalarAsync<long>(c, $"SELECT count(*) FROM fluxo.creator_jobs WHERE business_id='{other}'"));
        Assert.True(await DebateTestDb.ScalarAsync<long>(c, $"SELECT count(*) FROM fluxo.creator_jobs WHERE business_id='{business}'") > 0);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Sql_script_is_idempotent_and_produces_the_same_catalog_as_the_migration()
    {
        await DebateTestDb.EnsureAsync();
        // Gate corrigido (decisão D): o helper faz $"{prefix}_{guid:N}"[..40]; prefixo curto ("fcjobs") estourava o corte. Prefixo >= 8 caracteres.
        var scratch = await DebateTestDb.CreateScratchDatabaseAsync("fcjobsdb");
        try
        {
            await DebateTestDb.ExecAsync(scratch, """
                CREATE SCHEMA fluxo;
                CREATE TABLE fluxo.businesses (id character varying(128) NOT NULL PRIMARY KEY);
                CREATE TABLE fluxo."__EFMigrationsHistory" ("MigrationId" character varying(150) NOT NULL PRIMARY KEY, "ProductVersion" character varying(32) NOT NULL);
                """);
            var sql = DebateTestDb.Sql("creator-jobs.sql");
            await DebateTestDb.ExecAsync(scratch, sql);
            await DebateTestDb.ExecAsync(scratch, sql);
            Assert.Equal(await GateFc.CatalogAsync(DebateTestDb.Connection, "creator_jobs"), await GateFc.CatalogAsync(scratch, "creator_jobs"));
            var id = await DebateTestDb.ScalarAsync<string>(scratch, "SELECT string_agg(\"MigrationId\", ',') FROM fluxo.\"__EFMigrationsHistory\" WHERE \"MigrationId\" LIKE '%CreatorJobs'");
            Assert.NotNull(id);
            Assert.DoesNotContain(',', id!);
            Assert.True(string.CompareOrdinal(id![..14], "20261111214447") > 0, "timestamp da migration deve ser maior que 20261111214447");
            Assert.Equal(id, await DebateTestDb.ScalarAsync<string>(DebateTestDb.Connection, "SELECT \"MigrationId\" FROM fluxo.\"__EFMigrationsHistory\" WHERE \"MigrationId\" LIKE '%CreatorJobs'"));
            Assert.Contains("fluxo.creator_jobs", sql);
            Assert.DoesNotContain("uuid_generate", sql);
        }
        finally
        {
            await DebateTestDb.DropScratchDatabaseAsync(scratch);
        }
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Worker_role_reads_and_updates_only_creator_jobs_and_a_missing_role_never_breaks_the_grant()
    {
        await DebateTestDb.EnsureAsync();
        var admin = DebateTestDb.Connection;
        var hadWorker = await DebateTestDb.ScalarAsync<long>(admin, $"SELECT count(*) FROM pg_roles WHERE rolname = '{Worker}'") > 0;
        if (hadWorker) await DebateTestDb.ExecAsync(admin, $"ALTER ROLE {Worker} RENAME TO {Worker}_gatebak");
        // Gate corrigido (decisão D): mesmo corte [..40] do helper; prefixo >= 8 caracteres.
        var scratch = await DebateTestDb.CreateScratchDatabaseAsync("fcgrantdb");
        try
        {
            await DebateTestDb.InstallVectorAsync(scratch);
            await using (var context = DebateTestDb.Context(scratch)) await DebateTestDb.MigrateWithVectorAsync(context);
            await DebateTestDb.ExecAsync(scratch, """
                DO $r$ BEGIN
                  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='fluxo_api_runtime') THEN CREATE ROLE fluxo_api_runtime NOLOGIN; END IF;
                  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='fluxo_migrator_runtime') THEN CREATE ROLE fluxo_migrator_runtime NOLOGIN; END IF;
                END $r$;
                """);
            var name = new NpgsqlConnectionStringBuilder(scratch).Database!;
            var grants = DebateTestDb.Sql("grant-runtime.sql").Replace(":\"DBNAME\"", $"\"{name}\"", StringComparison.Ordinal);
            await DebateTestDb.ExecAsync(scratch, grants);
            foreach (var privilege in new[] { "SELECT", "INSERT", "UPDATE", "DELETE" })
                Assert.True(await DebateTestDb.ScalarAsync<bool>(scratch, $"SELECT has_table_privilege('fluxo_api_runtime','fluxo.creator_jobs','{privilege}')"), $"api runtime sem {privilege}");

            await DebateTestDb.ExecAsync(scratch, $"CREATE ROLE {Worker} NOLOGIN");
            await DebateTestDb.ExecAsync(scratch, grants);
            await DebateTestDb.ExecAsync(scratch, grants);
            Assert.True(await DebateTestDb.ScalarAsync<bool>(scratch, $"SELECT has_schema_privilege('{Worker}','fluxo','USAGE')"));
            foreach (var privilege in new[] { "SELECT", "UPDATE" })
                Assert.True(await DebateTestDb.ScalarAsync<bool>(scratch, $"SELECT has_table_privilege('{Worker}','fluxo.creator_jobs','{privilege}')"), $"worker sem {privilege}");
            foreach (var privilege in new[] { "INSERT", "DELETE" })
                Assert.False(await DebateTestDb.ScalarAsync<bool>(scratch, $"SELECT has_table_privilege('{Worker}','fluxo.creator_jobs','{privilege}')"), $"worker não pode {privilege}");
            Assert.Equal(0L, await DebateTestDb.ScalarAsync<long>(scratch,
                $"SELECT count(*) FROM pg_tables WHERE schemaname='fluxo' AND tablename <> 'creator_jobs' AND (has_table_privilege('{Worker}', format('%I.%I', schemaname, tablename), 'SELECT') OR has_table_privilege('{Worker}', format('%I.%I', schemaname, tablename), 'UPDATE'))"));
        }
        finally
        {
            await DebateTestDb.DropScratchDatabaseAsync(scratch);
            await DebateTestDb.ExecAsync(admin, $"DROP ROLE IF EXISTS {Worker}");
            if (hadWorker) await DebateTestDb.ExecAsync(admin, $"ALTER ROLE {Worker}_gatebak RENAME TO {Worker}");
        }
    }
}
