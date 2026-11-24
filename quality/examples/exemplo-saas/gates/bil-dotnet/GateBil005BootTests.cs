// Gate BIL-005-FALHA-FECHADA. Template do autor de gates. Usa Provider=asaas de propósito: com stub, a trava da BIL-002 aborta
// a subida antes e a falta de chave passaria sem prova. A exceção precisa citar ApplicationCrypto.
namespace Fluxo.Api.Tests;

public sealed class GateBil005BootTests
{
    private static Dictionary<string, string?> Enabled(params (string Key, string? Value)[] extra) => GateBil.Settings(
    [
        ("Billing:Provider", "asaas"), ("Asaas:BaseUrl", "https://api-sandbox.asaas.com/v3"), ("Asaas:WebhookToken", GateBil.Token), .. extra,
    ]);

    private static void AssertRefused(Dictionary<string, string?> settings)
    {
        using var factory = new GateProductionFactory(settings);
        var error = Assert.ThrowsAny<Exception>(() => factory.CreateClient());
        Assert.Contains("ApplicationCrypto", error.ToString());
    }

    [Fact]
    public void Production_with_billing_on_refuses_to_start_without_keys() => AssertRefused(Enabled());

    [Fact]
    public void Production_with_billing_on_refuses_a_short_encryption_key() => AssertRefused(Enabled(
        ("ApplicationCrypto:ActiveKeyId", "k1"), ("ApplicationCrypto:Keys:k1", GateCrypto.Url(new byte[16])), ("ApplicationCrypto:HmacKey", GateCrypto.Url(GateCrypto.HmacKey))));

    [Fact]
    public void Production_with_billing_on_refuses_a_short_hmac_key() => AssertRefused(Enabled(
        ("ApplicationCrypto:ActiveKeyId", "k1"), ("ApplicationCrypto:Keys:k1", GateCrypto.Url(GateCrypto.OldKey)), ("ApplicationCrypto:HmacKey", "curta")));

    [Fact]
    public async Task Production_with_billing_off_starts_without_keys()
    {
        using var factory = new GateProductionFactory(GateBil.Settings(("Billing:Enabled", "false")));
        using var client = factory.CreateClient();
        using var response = await client.GetAsync("/health/live");
        Assert.True(response.IsSuccessStatusCode);
    }
}
