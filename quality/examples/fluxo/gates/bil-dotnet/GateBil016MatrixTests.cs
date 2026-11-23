// Gate BIL-016-MATRIZ-IDEMPOTENTE. Template do autor de gates. Banco próprio: o teste altera valores e planos, e a carga não pode vazar para
// os outros gates. Os valores de Local, Pro e Rede são a proposta da spec e têm aceite manual em BIL-016-ACEITE-COMERCIAL.
using System.Text.Json;

namespace Fluxo.Api.Tests;

[Collection("GateBilSerial")]
public sealed class GateBil016MatrixTests
{
    private const string Existing = "existente";
    private const string Reserved = "novo sem recurso";
    private const string Applied = "aplicada";

    // chave, presenca, local, pro, rede, classe
    private static readonly (string Key, string Presenca, string Local, string Pro, string Rede, string Class)[] Matrix =
    [
        ("profile.claimed", "true", "true", "true", "true", Existing),
        ("catalog.items.max", "50", "200", "-1", "-1", Existing),
        ("menu.import.quota.month", "1", "3", "10", "-1", Existing),
        ("orders.enabled", "false", "true", "true", "true", Existing),
        ("orders.kitchen.enabled", "false", "false", "true", "true", Existing),
        ("agenda.enabled", "false", "true", "true", "true", Existing),
        ("agenda.recurrence.enabled", "false", "false", "true", "true", Existing),
        ("agenda.seats.max", "1", "1", "5", "-1", Existing),
        ("analytics.level", "\"summary\"", "\"summary\"", "\"funnel\"", "\"full\"", Existing),
        ("event.tools.enabled", "false", "false", "true", "true", Existing),
        ("event.checkin.enabled", "false", "false", "true", "true", Existing),
        ("coupons.active.max", "1", "3", "10", "-1", Reserved),
        ("queue.enabled", "false", "false", "true", "true", Reserved),
        ("queue.lines.max", "0", "0", "1", "-1", Reserved),
        ("campaigns.enabled", "false", "false", "true", "true", Reserved),
        ("analytics.export.enabled", "false", "false", "true", "true", Reserved),
        ("units.max", "1", "1", "3", "-1", Reserved),
        ("api.enabled", "false", "false", "false", "true", Reserved),
        ("notifications.quota.month", "200", "500", "2000", "10000", Reserved),
        ("supplier.leads.enabled", "true", "true", "true", "true", Reserved),
        ("integracao_psp.enabled", "false", "true", "true", "true", Applied),
    ];

    private static async Task<string> ScratchAsync()
    {
        var sql = GatePlan.MatrixSql();
        var connection = await DebateTestDb.CreateScratchDatabaseAsync("gate_matrix");
        await DebateTestDb.InstallVectorAsync(connection);
        await DebateTestDb.MigrateToLatestAsync(connection);
        await DebateTestDb.ExecAsync(connection, DebateTestDb.Sql("billing-mvp.sql"));
        await DebateTestDb.ExecAsync(connection, sql);
        return connection;
    }

    private static string Value(string connection, string plan, string key) => $"(SELECT s.value::text FROM fluxo.billing_entitlement_specs s JOIN fluxo.billing_products p ON p.id=s.product_id WHERE p.code='{plan}' AND s.key='{key}')";

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Load_has_exactly_the_matrix_of_the_spec()
    {
        var connection = await ScratchAsync();
        try
        {
            var rows = await GateBil.RowsAsync(connection, """
                SELECT p.code || '|' || s.key || '|' || s.value::text || '|' || s.value_kind || '|' || coalesce(s.notes,'')
                FROM fluxo.billing_entitlement_specs s JOIN fluxo.billing_products p ON p.id=s.product_id
                """);
            var expected = Matrix.SelectMany(m => new[] { ("presenca", m.Presenca), ("local", m.Local), ("pro", m.Pro), ("rede", m.Rede) }
                .Select(p => (Plan: p.Item1, Value: p.Item2, m.Key, m.Class)))
                .Select(x => $"{x.Plan}|{x.Key}|{x.Value}|{(x.Value is "true" or "false" ? "bool" : x.Value.StartsWith('"') ? "enum" : "int")}")
                .Order(StringComparer.Ordinal).ToArray();
            Assert.Equal(expected, rows.Select(r => string.Join('|', r.Split('|').Take(4))).Order(StringComparer.Ordinal).ToArray());
            foreach (var entry in Matrix)
                Assert.All(rows.Where(r => r.Split('|')[1] == entry.Key), r => Assert.Contains(entry.Class, r.Split('|')[4]));
        }
        finally { await DebateTestDb.DropScratchDatabaseAsync(connection); }
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Second_run_keeps_changed_values_and_restores_only_what_is_missing()
    {
        var connection = await ScratchAsync();
        try
        {
            var count = await DebateTestDb.ScalarAsync<long>(connection, "SELECT count(*) FROM fluxo.billing_entitlement_specs");
            await DebateTestDb.ExecAsync(connection, $"""
                UPDATE fluxo.billing_entitlement_specs SET value='7'::jsonb WHERE key='units.max' AND product_id=(SELECT id FROM fluxo.billing_products WHERE code='local');
                DELETE FROM fluxo.billing_entitlement_specs WHERE key='api.enabled' AND product_id=(SELECT id FROM fluxo.billing_products WHERE code='rede');
                """);
            await DebateTestDb.ExecAsync(connection, GatePlan.MatrixSql());
            Assert.Equal(count, await DebateTestDb.ScalarAsync<long>(connection, "SELECT count(*) FROM fluxo.billing_entitlement_specs"));
            Assert.Equal("7", await DebateTestDb.ScalarAsync<string>(connection, $"SELECT {Value(connection, "local", "units.max")}"));
            Assert.Equal("true", await DebateTestDb.ScalarAsync<string>(connection, $"SELECT {Value(connection, "rede", "api.enabled")}"));
        }
        finally { await DebateTestDb.DropScratchDatabaseAsync(connection); }
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Load_does_not_touch_products_or_prices()
    {
        var connection = await DebateTestDb.CreateScratchDatabaseAsync("gate_matrix");
        const string Snapshot = """
            SELECT string_agg(code || ':' || active::text || ':' || updated_at::text, ',' ORDER BY code) ||
                   (SELECT string_agg(id::text || ':' || amount_cents::text || ':' || active::text, ',' ORDER BY id) FROM fluxo.billing_prices)
            FROM fluxo.billing_products
            """;
        try
        {
            await DebateTestDb.InstallVectorAsync(connection);
            await DebateTestDb.MigrateToLatestAsync(connection);
            await DebateTestDb.ExecAsync(connection, DebateTestDb.Sql("billing-mvp.sql"));
            var before = await DebateTestDb.ScalarAsync<string>(connection, Snapshot);
            await DebateTestDb.ExecAsync(connection, GatePlan.MatrixSql());
            Assert.Equal(before, await DebateTestDb.ScalarAsync<string>(connection, Snapshot));
        }
        finally { await DebateTestDb.DropScratchDatabaseAsync(connection); }
    }
}
