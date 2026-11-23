// Gate BIL-004-DEDUP. Template do autor de gates. Exige PostgreSQL: a unicidade só se prova sob concorrência real.
using System.Net;
using System.Security.Cryptography;
using System.Text;

namespace Fluxo.Api.Tests;

public sealed class GateBil004DedupTests
{
    private static DebateApiFactory Api() => new(GateBil.C, settings: GateBil.WebhookSettings(("RateLimiting:Webhooks:AuthenticPermitLimit", "1000")));

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Same_event_twice_keeps_one_row_and_answers_200_twice()
    {
        await DebateTestDb.EnsureAsync();
        await using var factory = Api();
        using var client = factory.CreateClient();
        var id = $"evt_{Guid.NewGuid():N}";
        for (var i = 0; i < 2; i++)
        {
            using var response = await client.SendAsync(GateBil.Webhook(GateBil.WebhookPath, GateBil.EventBody(id), GateBil.Token));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }
        Assert.Equal(1L, await GateBil.WebhookRowsAsync(id));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Concurrent_deliveries_of_one_event_keep_one_row()
    {
        await DebateTestDb.EnsureAsync();
        await using var factory = Api();
        using var client = factory.CreateClient();
        var id = $"evt_{Guid.NewGuid():N}";
        var calls = Enumerable.Range(0, 16).Select(_ => client.SendAsync(GateBil.Webhook(GateBil.WebhookPath, GateBil.EventBody(id), GateBil.Token)));
        var responses = await Task.WhenAll(calls);
        Assert.All(responses, r => Assert.Equal(HttpStatusCode.OK, r.StatusCode));
        Assert.Equal(1L, await GateBil.WebhookRowsAsync(id));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Row_keeps_raw_body_and_provider_and_is_left_pending_without_a_processor()
    {
        await DebateTestDb.EnsureAsync();
        await using var factory = Api();
        using var client = factory.CreateClient();
        var id = $"evt_{Guid.NewGuid():N}";
        var body = GateBil.EventBody(id);
        using var response = await client.SendAsync(GateBil.Webhook(GateBil.WebhookPath, body, GateBil.Token));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var where = $"FROM fluxo.billing_webhook_events WHERE provider_event_id='{id}'";
        Assert.Equal(body, await DebateTestDb.ScalarAsync<string>(GateBil.C, $"SELECT raw_body {where}"));
        Assert.Equal("asaas", await DebateTestDb.ScalarAsync<string>(GateBil.C, $"SELECT provider {where}"));
        Assert.Equal("PAYMENT_RECEIVED", await DebateTestDb.ScalarAsync<string>(GateBil.C, $"SELECT event_type {where}"));
        Assert.Equal("pending", await DebateTestDb.ScalarAsync<string>(GateBil.C, $"SELECT status {where}"));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Event_without_id_is_deduplicated_by_body_hash()
    {
        await DebateTestDb.EnsureAsync();
        await using var factory = Api();
        using var client = factory.CreateClient();
        var body = $$"""{"event":"PAYMENT_RECEIVED","marker":"{{Guid.NewGuid():N}}"}""";
        for (var i = 0; i < 2; i++)
        {
            using var response = await client.SendAsync(GateBil.Webhook(GateBil.WebhookPath, body, GateBil.Token));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }
        var hash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(body)));
        Assert.Equal(1L, await GateBil.WebhookRowsAsync($"sha256:{hash}"));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Table_has_the_unique_key_and_the_status_index()
    {
        await DebateTestDb.EnsureAsync();
        var indexes = await GateBil.RowsAsync(GateBil.C, "SELECT indexdef FROM pg_indexes WHERE schemaname='fluxo' AND tablename='billing_webhook_events'");
        Assert.Contains(indexes, i => i.Contains("UNIQUE") && i.Contains("(provider, provider_event_id)"));
        Assert.Contains(indexes, i => i.Contains("(status, received_at)"));
    }
}
