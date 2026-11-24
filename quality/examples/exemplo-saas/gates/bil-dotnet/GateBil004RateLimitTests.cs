// Gate BIL-004-RATE-LIMIT-SEM-XFF. Template do autor de gates. Partição por provedor e resultado, nunca por IP.
using System.Net;

namespace Fluxo.Api.Tests;

public sealed class GateBil004RateLimitTests
{
    private static DebateApiFactory Api(params (string Key, string? Value)[] extra) => new(GateBil.C, settings: GateBil.WebhookSettings(extra));

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Thirty_rejections_do_not_block_the_next_authentic_call()
    {
        await DebateTestDb.EnsureAsync();
        await using var factory = Api();
        using var client = factory.CreateClient();
        for (var i = 0; i < 30; i++)
        {
            using var forged = await client.SendAsync(GateBil.Webhook(GateBil.WebhookPath, "{}", "token-errado"));
            Assert.Equal(HttpStatusCode.Unauthorized, forged.StatusCode);
        }
        using (var exhausted = await client.SendAsync(GateBil.Webhook(GateBil.WebhookPath, "{}", "token-errado")))
            Assert.Equal(HttpStatusCode.TooManyRequests, exhausted.StatusCode);
        using var authentic = await client.SendAsync(GateBil.Webhook(GateBil.WebhookPath, GateBil.EventBody($"evt_{Guid.NewGuid():N}"), GateBil.Token));
        Assert.Equal(HttpStatusCode.OK, authentic.StatusCode);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Forwarded_for_does_not_change_the_rejected_partition()
    {
        await DebateTestDb.EnsureAsync();
        await using var factory = Api(("RateLimiting:Webhooks:RejectedPermitLimit", "2"));
        using var client = factory.CreateClient();
        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 3; i++)
        {
            using var response = await client.SendAsync(GateBil.Webhook(GateBil.WebhookPath, "{}", "token-errado", $"203.0.113.{i + 1}"));
            statuses.Add(response.StatusCode);
        }
        Assert.Equal([HttpStatusCode.Unauthorized, HttpStatusCode.Unauthorized, HttpStatusCode.TooManyRequests], statuses);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Forwarded_for_does_not_change_the_authentic_partition()
    {
        await DebateTestDb.EnsureAsync();
        await using var factory = Api(("RateLimiting:Webhooks:AuthenticPermitLimit", "2"));
        using var client = factory.CreateClient();
        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 3; i++)
        {
            using var response = await client.SendAsync(GateBil.Webhook(GateBil.WebhookPath, GateBil.EventBody($"evt_{Guid.NewGuid():N}"), GateBil.Token, $"203.0.113.{i + 1}"));
            statuses.Add(response.StatusCode);
        }
        Assert.Equal([HttpStatusCode.OK, HttpStatusCode.OK, HttpStatusCode.TooManyRequests], statuses);
    }
}
