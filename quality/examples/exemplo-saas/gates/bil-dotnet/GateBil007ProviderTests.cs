// Gate BIL-007-PROVEDOR-ASAAS. Template do autor de gates. A chave vem de configuração comum (Asaas:ApiKey, que no Cloud Run é a
// variável Asaas__ApiKey): o gate não exige Secret Manager em tempo de execução.
using System.Net;
using Fluxo.Api.Modules.Billing.Gateways;
using Microsoft.Extensions.DependencyInjection;

namespace Fluxo.Api.Tests;

public sealed class GateBil007ProviderTests
{
    private static (string, string?)[] Asaas(string provider) =>
    [
        ("Billing:Provider", provider), ("Asaas:BaseUrl", "https://asaas.gate.invalid/v3"), ("Asaas:ApiKey", "gate-api-key"),
        ("Asaas:WebhookToken", GateBil.Token), .. GateCrypto.Keys(),
    ];

    [Fact]
    public async Task Production_accepts_the_asaas_provider_and_resolves_its_gateway()
    {
        using var factory = new GateProductionFactory(GateBil.Settings(Asaas("asaas")));
        using var client = factory.CreateClient();
        using var response = await client.GetAsync("/health/live");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var scope = factory.Services.CreateScope();
        var gateway = scope.ServiceProvider.GetRequiredService<IBillingGateway>();
        Assert.Equal("AsaasBillingGateway", gateway.GetType().Name);
        Assert.Equal("asaas", gateway.Provider);
    }

    [Fact]
    public void Production_keeps_refusing_the_stub()
    {
        using var factory = new GateProductionFactory(GateBil.Settings(Asaas("stub")));
        var error = Assert.ThrowsAny<Exception>(() => factory.CreateClient());
        Assert.Contains("stub", error.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Unknown_provider_is_refused_even_outside_production()
    {
        using var factory = new DebateApiFactory(settings: GateBil.Settings(("Billing:Provider", "pagador-gate")));
        var error = Assert.ThrowsAny<Exception>(() => factory.CreateClient());
        Assert.Contains("Provider", error.ToString());
    }

    [Fact]
    public void Testing_with_the_stub_still_resolves_the_stub()
    {
        using var factory = new DebateApiFactory(settings: GateBil.Settings());
        using var scope = factory.Services.CreateScope();
        Assert.Equal("stub", scope.ServiceProvider.GetRequiredService<IBillingGateway>().Provider);
    }
}
