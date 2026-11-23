// Gate DV-009-COSTS. Template do autor de gates: copiado para backend/tests/Fluxo.Api.Tests só durante o gate.
// Caminho real: ai-runs do worker (POST /internal/debates/{id}/ai-runs, agora com webSearchRequests: pendência da DV-005)
// -> GET /admin/debates/{id}/costs (consolidação idempotente em debate_costs)
// -> GET /admin/debates/{id}/report (DV-007) traz costs preenchido (pendência da DV-007).
using System.Net;
using System.Text.Json;
using Fluxo.Api.Modules.Debates;
using Npgsql;

namespace Fluxo.Api.Tests;

public sealed class DebateDv009CostsGateTests
{
    private static async Task<(DebateApiFactory Factory, Guid DebateId, HttpClient Worker, HttpClient Admin)> SeedAsync()
    {
        await DebateTestDb.EnsureAsync();
        await using var db = DebateTestDb.Context();
        var live = await DebateSeed.LiveCheckAsync(db);
        var factory = new DebateApiFactory(DebateTestDb.Connection);
        var uid = $"cost-{Guid.NewGuid():N}";
        factory.Registry.Grant(uid, "admin", "debates.manage");
        return (factory, live.Debate.Id, factory.Client(WorkerTokens.Create()), factory.Client(DebateApiFactory.Admin(uid)));
    }

    private static async Task<Guid> RunAsync(HttpClient worker, Guid debate, object body)
    {
        using var response = await DebateApiFactory.SendAsync(worker, HttpMethod.Post, $"/api/v1/internal/debates/{debate}/ai-runs", body);
        var json = await response.Content.ReadAsStringAsync();
        Assert.True(response.StatusCode == HttpStatusCode.Created, $"ai-run: {(int)response.StatusCode} {json}");
        return JsonDocument.Parse(json).RootElement.GetProperty("aiRunId").GetGuid();
    }

    private static async Task SeedRunsAsync(HttpClient worker, Guid debate)
    {
        await RunAsync(worker, debate, new { kind = "asr_live", provider = "soniox", model = "stt-rt-v3", region = "global",
            inputTokens = 0, outputTokens = 0, audioSeconds = 600m, latencyMs = 5, status = "ok" });
        await RunAsync(worker, debate, new { kind = "asr_async", provider = "soniox", model = "stt-async-v5", region = "global",
            inputTokens = 0, outputTokens = 0, audioSeconds = 1200m, latencyMs = 5, status = "ok" });
        await RunAsync(worker, debate, new { kind = "verdict", provider = "vertex-anthropic", model = "claude-sonnet-gate", region = "global",
            inputTokens = 1000, outputTokens = 200, latencyMs = 5, status = "ok", webSearchRequests = 3 });
        await RunAsync(worker, debate, new { kind = "extraction", provider = "vertex-anthropic", model = "claude-haiku-gate", region = "global",
            inputTokens = 500, outputTokens = 50, latencyMs = 5, status = "ok" });
    }

    private static decimal Num(JsonElement obj, string name)
    {
        Assert.True(obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number, $"costs sem '{name}' numérico: {obj}");
        return v.GetDecimal();
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Ai_run_persists_web_search_requests()
    {
        var (factory, debate, worker, _) = await SeedAsync();
        await using var _f = factory;
        var id = await RunAsync(worker, debate, new { kind = "verdict", provider = "vertex-anthropic", model = "claude-sonnet-gate",
            region = "global", inputTokens = 10, outputTokens = 5, latencyMs = 5, status = "ok", webSearchRequests = 4 });
        await using var conn = new NpgsqlConnection(DebateTestDb.Connection);
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand("SELECT web_search_requests FROM fluxo.debate_ai_runs WHERE id = @id", conn);
        cmd.Parameters.AddWithValue("id", id);
        Assert.Equal(4, Convert.ToInt32(await cmd.ExecuteScalarAsync()));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Costs_consolidate_asr_minutes_tokens_by_model_and_searches_idempotently()
    {
        var (factory, debate, worker, admin) = await SeedAsync();
        await using var _f = factory;
        await SeedRunsAsync(worker, debate);

        var totals = new List<decimal>();
        for (var i = 0; i < 2; i++)
        {
            using var response = await admin.GetAsync($"/api/v1/admin/debates/{debate}/costs");
            var json = await response.Content.ReadAsStringAsync();
            Assert.True(response.StatusCode == HttpStatusCode.OK, $"costs: {(int)response.StatusCode} {json}");
            var costs = JsonDocument.Parse(json).RootElement.Clone();
            totals.Add(Num(costs, "estimatedTotalUsd"));
            Assert.Equal(10m, Num(costs, "asrLiveMinutes"));
            Assert.Equal(20m, Num(costs, "asrAsyncMinutes"));
            Assert.True(Num(costs, "searches") >= 3, "buscas web do veredito (webSearchRequests) entram em searches");
            Assert.True(Num(costs, "estimatedTotalUsd") > 0);
            var tokens = costs.GetProperty("tokensByModel").ToString();
            Assert.Contains("claude-sonnet-gate", tokens);
            Assert.Contains("claude-haiku-gate", tokens);
            Assert.Contains("1000", tokens);
        }
        Assert.Equal(totals[0], totals[1]);
        var rows = await DebateTestDb.ScalarAsync<long>(DebateTestDb.Connection,
            $"SELECT count(*) FROM fluxo.debate_costs WHERE debate_id = '{debate}'");
        Assert.Equal(1L, rows);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Operational_report_brings_costs_and_cards()
    {
        var (factory, debate, worker, admin) = await SeedAsync();
        await using var _f = factory;
        await SeedRunsAsync(worker, debate);
        using (var costs = await admin.GetAsync($"/api/v1/admin/debates/{debate}/costs"))
            Assert.Equal(HttpStatusCode.OK, costs.StatusCode);

        using var response = await admin.GetAsync($"/api/v1/admin/debates/{debate}/report");
        var json = await response.Content.ReadAsStringAsync();
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"report: {(int)response.StatusCode} {json}");
        var report = JsonDocument.Parse(json).RootElement;
        Assert.True(report.TryGetProperty("costs", out var c) && c.ValueKind == JsonValueKind.Object, $"report.costs deve vir preenchido: {json}");
        Assert.Equal(10m, Num(c, "asrLiveMinutes"));
        Assert.True(report.TryGetProperty("cards", out var cards) && cards.ValueKind == JsonValueKind.Array, $"report.cards[] ausente: {json}");
    }
}
