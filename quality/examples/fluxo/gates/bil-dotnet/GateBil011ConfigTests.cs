// Gates BIL-011. Template do autor de gates. Emissão de NFS-e pelo gateway real sobre o Asaas de mentira, com configuração fictícia só deste arquivo.
// Inscrição municipal, alíquota e prefeitura ficam em BIL-011-SANDBOX-NFSE, manual. A lista de tipos usa reflexão: o emissor não tem caminho fixo aqui.
using System.Net;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Fluxo.Api.Tests;

public sealed class GateBil011ConfigTests
{
    private static DebateApiFactory Api(params (string Key, string? Value)[] settings) =>
        new(settings: GateBil.Settings(settings));

    private static (string, string?)[] Without(string key) => GateFiscal.Complete.Where(x => x.Key != key).ToArray();

    [Theory]
    [InlineData("Billing:Fiscal:MunicipalServiceCode")]
    [InlineData("Billing:Fiscal:MunicipalServiceName")]
    [InlineData("Billing:Fiscal:ServiceDescription")]
    public async Task Enabled_with_a_missing_field_refuses_to_start(string missing)
    {
        await using var factory = Api(Without(missing));
        _ = GateBil.Find("FiscalOptions");
        Assert.ThrowsAny<Exception>(() => factory.Services);
    }

    [Fact]
    public async Task Enabled_with_both_service_ids_refuses_to_start()
    {
        await using var factory = Api([.. GateFiscal.Complete, ("Billing:Fiscal:MunicipalServiceId", "gate-id")]);
        _ = GateBil.Find("FiscalOptions");
        Assert.ThrowsAny<Exception>(() => factory.Services);
    }

    [Fact]
    public async Task Complete_starts_with_the_asaas_issuer_and_disabled_needs_no_field()
    {
        await using (var complete = Api([.. GateFiscal.Complete, ("Billing:Provider", "asaas"), ("Asaas:BaseUrl", "https://asaas.gate.invalid/v3"), ("Asaas:ApiKey", "gate-api-key-nao-real")]))
        using (var scope = complete.Services.CreateScope())
            Assert.Equal("AsaasFiscalDocumentIssuer", scope.ServiceProvider.GetRequiredService(GateBil.Find("IFiscalDocumentIssuer")).GetType().Name);
        await using var off = Api();
        using var offScope = off.Services.CreateScope();
        Assert.Equal("NoopFiscalDocumentIssuer", offScope.ServiceProvider.GetRequiredService(GateBil.Find("IFiscalDocumentIssuer")).GetType().Name);
    }
}
