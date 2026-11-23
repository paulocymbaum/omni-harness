// Gate BIL-016-MIDDLEWARE-FALHA-FECHADA. Template do autor de gates. Passa pelo pipeline real, em rota de mentira com o marcador real.
using System.Net;
using System.Text.Json;

namespace Fluxo.Api.Tests;

[Collection("GateBilSerial")]
public sealed class GateBil016MiddlewareTests
{
    private const string DeadDatabase = "Host=127.0.0.1;Port=1;Database=unused;Username=unused;Password=unused;Timeout=2";

    private static async Task<(string Id, HttpClient Client, DebateApiFactory Factory)> OpenAsync()
    {
        await GatePlan.ApplyMatrixAsync();
        var factory = GatePlan.Api();
        var (id, owner) = await GateBil.SeedBusinessAsync();
        return (id, factory.Client($"user:{owner}"), factory);
    }

    private static async Task AssertRefusedAsync(HttpResponseMessage response, string planCode)
    {
        var text = await response.Content.ReadAsStringAsync();
        Assert.True(response.StatusCode == HttpStatusCode.Forbidden, $"HTTP {(int)response.StatusCode}: {text}");
        var values = GateBil.Strings(JsonDocument.Parse(text).RootElement).ToArray();
        Assert.Contains("billing_feature_requires_plan", values);
        Assert.Contains(GatePlan.Psp, values);
        Assert.Contains(planCode, values);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Local_opens_and_presenca_is_refused_with_the_key_and_plan()
    {
        var (id, client, factory) = await OpenAsync();
        await using var _f = factory;
        using var _c = client;
        await GatePlan.SetPlanAsync(id, "presenca");
        using (var refused = await GatePlan.CallMarkedAsync(client, id)) await AssertRefusedAsync(refused, "presenca");
        await GatePlan.SetPlanAsync(id, "local");
        using var open = await GatePlan.CallMarkedAsync(client, id);
        Assert.Equal(HttpStatusCode.OK, open.StatusCode);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task No_subscription_is_refused_as_presenca()
    {
        var (id, client, factory) = await OpenAsync();
        await using var _f = factory;
        using var _c = client;
        using var refused = await GatePlan.CallMarkedAsync(client, id);
        await AssertRefusedAsync(refused, "presenca");
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Past_due_keeps_the_new_feature_and_canceled_loses_it_keeping_the_data()
    {
        var (id, client, factory) = await OpenAsync();
        await using var _f = factory;
        using var _c = client;
        await GatePlan.SetPlanAsync(id, "local", "past_due");
        using (var kept = await GatePlan.CallMarkedAsync(client, id)) Assert.Equal(HttpStatusCode.OK, kept.StatusCode);
        var rows = await DebateTestDb.ScalarAsync<long>(GateBil.C, $"SELECT count(*) FROM fluxo.billing_subscriptions s JOIN fluxo.billing_customers c ON c.id=s.customer_id WHERE c.subject_id='{id}'");
        await GatePlan.SetPlanAsync(id, "local", "canceled");
        using (var lost = await GatePlan.CallMarkedAsync(client, id)) await AssertRefusedAsync(lost, "presenca");
        Assert.Equal(rows + 1, await DebateTestDb.ScalarAsync<long>(GateBil.C, $"SELECT count(*) FROM fluxo.billing_subscriptions s JOIN fluxo.billing_customers c ON c.id=s.customer_id WHERE c.subject_id='{id}'"));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Manual_plan_opens_the_feature_for_the_pilot()
    {
        var (id, client, factory) = await OpenAsync();
        await using var _f = factory;
        using var _c = client;
        await GatePlan.SetPlanAsync(id, "local", "active", "manual");
        using var open = await GatePlan.CallMarkedAsync(client, id);
        Assert.Equal(HttpStatusCode.OK, open.StatusCode);
    }

    [Theory, Trait("Category", "PostgresIntegration")]
    [InlineData("queue.lines.max", "pro", HttpStatusCode.OK)]      // 1
    [InlineData("api.enabled", "pro", HttpStatusCode.Forbidden)]   // false
    [InlineData("queue.lines.max", "local", HttpStatusCode.Forbidden)] // 0
    [InlineData("queue.lines.max", "rede", HttpStatusCode.OK)]     // -1: sem limite, diferente de 0
    [InlineData("chave.que.nao.existe", "rede", HttpStatusCode.Forbidden)]
    public async Task Values_decide_true_or_nonzero_open_the_rest_refuses(string key, string plan, HttpStatusCode expected)
    {
        var (id, client, factory) = await OpenAsync();
        await using var _f = factory;
        using var _c = client;
        await GatePlan.SetPlanAsync(id, plan);
        using var response = await GatePlan.CallMarkedAsync(client, id, key);
        Assert.Equal(expected, response.StatusCode);
    }

    [Fact]
    public async Task Billing_off_refuses_with_feature_unavailable_without_opening_the_database()
    {
        await using var factory = GatePlan.Api(DeadDatabase, ("Billing:Enabled", "false"));
        _ = GatePlan.MarkerType;
        using var client = factory.Client("user:gate-off");
        using var response = await GatePlan.CallMarkedAsync(client, "gate-off");
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal("billing_feature_unavailable", await DebateApiFactory.CodeAsync(response));
    }

    [Fact]
    public async Task Database_down_fails_closed_with_503_and_unmarked_route_does_not_touch_it()
    {
        await using var factory = GatePlan.Api(DeadDatabase);
        using var client = factory.Client("user:gate-down");
        using (var marked = await GatePlan.CallMarkedAsync(client, "gate-down"))
            Assert.Equal(HttpStatusCode.ServiceUnavailable, marked.StatusCode);
        // Mesmo pipeline, mesmo banco fora: sem o marcador, o middleware não consulta nada.
        using var plain = await client.GetAsync(GatePlan.Plain);
        Assert.Equal(HttpStatusCode.OK, plain.StatusCode);
    }

    [Fact]
    public void Plan_feature_value_is_neutral_and_lives_with_the_marker()
    {
        Assert.Equal(GatePlan.MarkerType.Namespace, GateBil.Find("PlanFeatureValue").Namespace);
        Assert.StartsWith("Fluxo.Api.Modules.Billing", GateBil.Find("PlanFeatureMiddleware").Namespace);
    }
}
