// Gate BIL-004-TOKEN-TEMPO-CONSTANTE. Template do autor de gates. Token no cabeçalho, com rotação e falha fechada.
using System.Net;

namespace Fluxo.Api.Tests;

public sealed class GateBil004TokenTests
{
    private static DebateApiFactory Api(params (string Key, string? Value)[] extra) => new(GateBil.C, settings: GateBil.WebhookSettings(extra));

    [Theory, Trait("Category", "PostgresIntegration")]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("token-errado")]
    public async Task Missing_or_wrong_token_is_refused_without_a_row(string? token)
    {
        await DebateTestDb.EnsureAsync();
        await GateBil.WebhookRowsAsync("sonda");
        await using var factory = Api();
        using var client = factory.CreateClient();
        var id = $"evt_{Guid.NewGuid():N}";
        using var response = await client.SendAsync(GateBil.Webhook(GateBil.WebhookPath, GateBil.EventBody(id), token));
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal("webhook_unauthorized", await DebateApiFactory.CodeAsync(response));
        Assert.Equal(0L, await GateBil.WebhookRowsAsync(id));
    }

    [Theory, Trait("Category", "PostgresIntegration")]
    [InlineData(GateBil.Token)]
    [InlineData(GateBil.PreviousToken)]
    public async Task Current_and_previous_tokens_are_accepted(string token)
    {
        await DebateTestDb.EnsureAsync();
        await using var factory = Api();
        using var client = factory.CreateClient();
        var id = $"evt_{Guid.NewGuid():N}";
        using var response = await client.SendAsync(GateBil.Webhook(GateBil.WebhookPath, GateBil.EventBody(id), token));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(1L, await GateBil.WebhookRowsAsync(id));
    }

    [Fact]
    public async Task Without_configured_token_the_route_fails_closed()
    {
        await using var factory = new DebateApiFactory(settings: GateBil.Settings());
        using var client = factory.CreateClient();
        using var response = await client.SendAsync(GateBil.Webhook(GateBil.WebhookPath, GateBil.EventBody("evt_y"), "qualquer"));
        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal("webhook_unavailable", await DebateApiFactory.CodeAsync(response));
    }
}
