// Gate BIL-016-CATALOGO-SEM-PROMESSA. Template do autor de gates. Banco próprio, porque precisa ligar plano pago para vê-lo no catálogo.
// A tela só pode prometer o que é aplicado: chave informativa ou reservada não sai na rota anônima.
using System.Net;
using System.Reflection;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Fluxo.Api.Tests;

[Collection("GateBilSerial")]
public sealed class GateBil016CatalogTests
{
    private static async Task<string> ScratchWithPaidPlanAsync()
    {
        var sql = GatePlan.MatrixSql();
        var connection = await DebateTestDb.CreateScratchDatabaseAsync("gate_catalog");
        await DebateTestDb.InstallVectorAsync(connection);
        await DebateTestDb.MigrateToLatestAsync(connection);
        await DebateTestDb.ExecAsync(connection, DebateTestDb.Sql("billing-mvp.sql"));
        await DebateTestDb.ExecAsync(connection, sql);
        await DebateTestDb.ExecAsync(connection, """
            UPDATE fluxo.billing_products SET active=true WHERE code='local';
            UPDATE fluxo.billing_prices SET active=true WHERE product_id=(SELECT id FROM fluxo.billing_products WHERE code='local');
            """);
        return connection;
    }

    private static string[] SellableKeys()
    {
        var field = GateBil.Find("PlanFeatureKeys").GetMember("Sellable", BindingFlags.Public | BindingFlags.Static).Single();
        var value = field switch { FieldInfo f => f.GetValue(null), PropertyInfo p => p.GetValue(null), _ => null };
        return Assert.IsAssignableFrom<IEnumerable<string>>(value).ToArray();
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Anonymous_catalog_brings_only_the_sellable_features_and_keeps_the_prices()
    {
        Assert.Equal([GatePlan.Psp], SellableKeys());
        var connection = await ScratchWithPaidPlanAsync();
        try
        {
            await using var factory = new DebateApiFactory(connection, settings: GateBil.Settings());
            using var client = factory.CreateClient();
            using var response = await client.GetAsync("/api/v1/billing/catalog");
            var body = await GateBil.JsonAsync(response);
            var local = body.GetProperty("items").EnumerateArray().Single(p => p.GetProperty("code").GetString() == "local");
            Assert.True(local.GetProperty("prices").GetArrayLength() > 0);
            var feature = Assert.Single(local.GetProperty("features").EnumerateArray());
            Assert.Equal(GatePlan.Psp, feature.GetProperty("key").GetString());
            Assert.Equal(JsonValueKind.True, feature.GetProperty("value").ValueKind);
            var text = body.GetRawText();
            foreach (var key in new[] { "catalog.items.max", "orders.enabled", "queue.enabled", "analytics.level", "supplier.leads.enabled" })
                Assert.DoesNotContain(key, text, StringComparison.Ordinal);
        }
        finally { await DebateTestDb.DropScratchDatabaseAsync(connection); }
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Catalog_without_a_token_still_answers_200_and_inactive_plan_stays_out()
    {
        await GatePlan.ApplyMatrixAsync();
        await using var factory = new DebateApiFactory(GateBil.C, settings: GateBil.Settings());
        using var client = factory.CreateClient();
        using var response = await client.GetAsync("/api/v1/billing/catalog");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var items = (await GateBil.JsonAsync(response)).GetProperty("items").EnumerateArray().ToArray();
        Assert.DoesNotContain(items, p => p.GetProperty("code").GetString() == "pro");
        Assert.All(items, p => Assert.Equal(JsonValueKind.Array, p.GetProperty("features").ValueKind));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Admin_subject_shows_the_matrix_with_its_class_under_billing_read()
    {
        await GatePlan.ApplyMatrixAsync();
        await using var factory = new DebateApiFactory(GateBil.C, settings: GateBil.Settings());
        var (id, _) = await GateBil.SeedBusinessAsync();
        await GatePlan.SetPlanAsync(id, "local");
        var uid = $"admin-{Guid.NewGuid():N}";
        factory.Registry.Grant(uid, "admin", "billing.read");
        using var client = factory.Client(DebateApiFactory.Admin(uid));
        using var response = await client.GetAsync($"/api/v1/admin/billing/subjects/business/{id}");
        var rows = (await GateBil.JsonAsync(response)).GetProperty("entitlements").EnumerateArray().ToArray();
        var psp = rows.Single(x => x.GetProperty("key").GetString() == GatePlan.Psp);
        Assert.Equal(JsonValueKind.True, psp.GetProperty("value").ValueKind);
        Assert.Contains("aplicada", psp.GetProperty("class").GetString());
        var existing = rows.Single(x => x.GetProperty("key").GetString() == "orders.enabled");
        Assert.Contains("existente", existing.GetProperty("class").GetString());
    }
}
