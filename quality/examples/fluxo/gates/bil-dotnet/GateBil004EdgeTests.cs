// Gate BIL-004-BORDA-EXATA. Template do autor de gates. O controle positivo (POST exato autenticado) impede que a recusa passe no vazio.
using System.Net;

namespace Fluxo.Api.Tests;

public sealed class GateBil004EdgeTests
{
    private static DebateApiFactory Api() => new(GateBil.C, settings: GateBil.WebhookSettings());

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Only_the_exact_post_reaches_the_webhook()
    {
        await DebateTestDb.EnsureAsync();
        await using var factory = Api();
        using var client = factory.CreateClient();
        var id = $"evt_{Guid.NewGuid():N}";
        using var exact = await client.SendAsync(GateBil.Webhook(GateBil.WebhookPath, GateBil.EventBody(id), GateBil.Token));
        Assert.Equal(HttpStatusCode.OK, exact.StatusCode);
    }

    [Theory, Trait("Category", "PostgresIntegration")]
    [InlineData("GET")]
    [InlineData("PUT")]
    [InlineData("PATCH")]
    [InlineData("DELETE")]
    public async Task Other_methods_stay_behind_firebase(string method)
    {
        await using var factory = Api();
        using var client = factory.CreateClient();
        using var request = new HttpRequestMessage(new HttpMethod(method), GateBil.WebhookPath);
        request.Headers.TryAddWithoutValidation("asaas-access-token", GateBil.Token);
        using var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal("firebase_id_token_required", await DebateApiFactory.CodeAsync(response));
    }

    [Theory, Trait("Category", "PostgresIntegration")]
    [InlineData("/webhooks/billing/asaas/")]
    [InlineData("/webhooks/billing/ASAAS")]
    [InlineData("/webhooks/billing/outro")]
    [InlineData("/webhooks/billing/asaas/extra")]
    [InlineData("/api/v1/webhooks/billing/asaas")]
    public async Task Other_paths_stay_behind_firebase(string path)
    {
        await using var factory = Api();
        using var client = factory.CreateClient();
        using var response = await client.SendAsync(GateBil.Webhook(path, GateBil.EventBody("evt_x"), GateBil.Token));
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal("firebase_id_token_required", await DebateApiFactory.CodeAsync(response));
    }

    [Fact]
    public void Webhook_paths_are_a_fixed_constant()
    {
        var type = GateBil.Find("PspWebhookPaths");
        Assert.True(type.IsAbstract && type.IsSealed, "PspWebhookPaths deve ser static");
        Assert.Equal(GateBil.WebhookPath, type.GetField("Asaas")!.GetRawConstantValue());
    }
}
