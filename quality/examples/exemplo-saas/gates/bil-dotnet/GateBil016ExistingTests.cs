// Gate BIL-016-RECURSOS-EXISTENTES-INTACTOS. Template do autor de gates. Com a matriz carregada e o middleware no pipeline, recurso que já
// existia responde igual em qualquer estado de plano. Cada teste prova antes que o corte funciona em rota marcada: sem isso, "igual"
// passaria só por não haver corte nenhum.
using System.Net;

namespace Fluxo.Api.Tests;

[Collection("GateBilSerial")]
public sealed class GateBil016ExistingTests
{
    private static async Task<(string Body, HttpStatusCode Status)> ReadAsync(HttpClient client, string route)
    {
        using var response = await client.GetAsync(route);
        return (await response.Content.ReadAsStringAsync(), response.StatusCode);
    }

    private static async Task<string> CreateAsync(HttpClient client, string route, object body)
    {
        using var response = await DebateApiFactory.SendAsync(client, HttpMethod.Post, route, body);
        return (await GateBil.JsonAsync(response)).GetProperty("id").GetString()!;
    }

    private static async Task AssertCutIsLiveAsync(HttpClient client, string id)
    {
        using var refused = await GatePlan.CallMarkedAsync(client, id);
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Existing_routes_answer_the_same_with_no_plan_presenca_canceled_and_paid()
    {
        await GatePlan.ApplyMatrixAsync();
        await using var factory = GatePlan.Api();
        var (id, owner) = await GateBil.SeedBusinessAsync();
        using var client = factory.Client($"user:{owner}");
        var merchant = await CreateAsync(client, "/api/v1/fluxo-empresas/merchants", new { businessId = id, name = "Casa Gate", type = "restaurant" });
        var category = await CreateAsync(client, $"/api/v1/fluxo-empresas/merchants/{merchant}/categories", new { name = "Pratos", sequence = 1, active = true });
        string[] routes = [$"/api/v1/businesses/{id}", $"/api/v1/businesses/{id}/team", $"/api/v1/fluxo-empresas/merchants/{merchant}", $"/api/v1/fluxo-empresas/merchants/{merchant}/menu"];
        await AssertCutIsLiveAsync(client, id);
        var before = new List<(string Body, HttpStatusCode Status)>();
        foreach (var route in routes) before.Add(await ReadAsync(client, route));
        Assert.All(before, answer => Assert.Equal(HttpStatusCode.OK, answer.Status));

        foreach (var (code, status) in new (string?, string)[] { ("presenca", "active"), ("local", "canceled"), ("local", "incomplete_expired"), ("local", "active"), (null, "") })
        {
            await GatePlan.SetPlanAsync(id, code, status);
            for (var i = 0; i < routes.Length; i++) Assert.Equal(before[i], await ReadAsync(client, routes[i]));
        }
        await CreateAsync(client, $"/api/v1/fluxo-empresas/merchants/{merchant}/categories/{category}/items", new { name = "Depois do plano", price = 10m, available = true });
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Catalog_limit_of_the_matrix_is_not_applied_to_the_existing_menu()
    {
        await GatePlan.ApplyMatrixAsync();
        await using var factory = GatePlan.Api();
        var (id, owner) = await GateBil.SeedBusinessAsync();
        using var client = factory.Client($"user:{owner}");
        var merchant = await CreateAsync(client, "/api/v1/fluxo-empresas/merchants", new { businessId = id, name = "Casa Gate", type = "restaurant" });
        var category = await CreateAsync(client, $"/api/v1/fluxo-empresas/merchants/{merchant}/categories", new { name = "Pratos", sequence = 1, active = true });
        await GatePlan.SetPlanAsync(id, "presenca");
        await AssertCutIsLiveAsync(client, id);
        // catalog.items.max é 50 em Presença e a §1.2 viraria somente-leitura; vale a §18: limite de recurso existente é informativo.
        for (var i = 0; i < 51; i++)
            await CreateAsync(client, $"/api/v1/fluxo-empresas/merchants/{merchant}/categories/{category}/items", new { name = $"Item {i}", price = 10m, available = true });
        Assert.Equal(51, await DebateTestDb.ScalarAsync<long>(GateBil.C,
            $"SELECT count(*) FROM fluxo.menu_items WHERE category_id='{category}'"));
    }
}
