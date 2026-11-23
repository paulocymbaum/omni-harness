// Gate BIL-007-CONTRATO-GATEWAY. Template do autor de gates. Payloads do Asaas por fixture, sobre HTTP falso em host .invalid.
// A chave vem de Asaas:ApiKey por IOptions; o caminho do segredo até a configuração não é assunto deste gate.
using System.Diagnostics;
using System.Net;
using System.Text.Json;
using Fluxo.Api.Modules.Billing.Domain;
using Fluxo.Api.Modules.Billing.Gateways;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Fluxo.Api.Tests;

public sealed class GateBil007GatewayContractTests
{
    private const string Key = "gate-api-key-nao-real";
    private const string TaxId = "12ABC34501DE35";

    private static (DebateApiFactory Factory, GateAsaasHttp Http, GateLogs Logs) Api()
    {
        var (http, logs) = (new GateAsaasHttp(), new GateLogs());
        var factory = new DebateApiFactory(services: s => { GateAsaasHttp.Install(http)(s); s.AddSingleton<ILoggerProvider>(logs); },
            settings: GateBil.Settings(("Billing:Provider", "asaas"), ("Asaas:BaseUrl", "https://asaas.gate.invalid/v3"), ("Asaas:ApiKey", Key)));
        return (factory, http, logs);
    }

    private static IBillingGateway Gateway(IServiceScope scope) => scope.ServiceProvider.GetRequiredService<IBillingGateway>();

    private static string Payment(string status, string value = "39.00", bool deleted = false) => $$"""
        {"object":"payment","id":"pay_gate","customer":"cus_gate","value":{{value}},"netValue":{{value}},"billingType":"PIX","status":"{{status}}",
         "dueDate":"2026-11-02","externalReference":"ref-gate","deleted":{{(deleted ? "true" : "false")}},"paymentDate":"2026-11-01"}
        """;

    private static GatewayPixChargeRequest PixRequest() => new("cus_gate", "ref-gate", 3990, "Plano Gate", DateTimeOffset.UtcNow.AddHours(1));

    [Fact]
    public async Task Create_pix_posts_the_payment_reads_the_qr_and_sends_access_token()
    {
        var (factory, http, _) = Api();
        await using var _f = factory;
        http.Respond = (request, _) => Task.FromResult(GateAsaasHttp.Json(request.RequestUri!.AbsolutePath.EndsWith("/pixQrCode")
            ? """{"encodedImage":"R0FURQ==","payload":"000201-gate","expirationDate":"2026-11-02 23:59:59"}""" : Payment("PENDING", "39.90")));
        using var scope = factory.Services.CreateScope();
        var pix = await Gateway(scope).CreatePixChargeAsync(PixRequest(), CancellationToken.None);
        Assert.Equal("pay_gate", pix.ExternalChargeId);
        Assert.Equal("000201-gate", pix.BrCode);
        Assert.StartsWith("data:image/", pix.QrImageDataUri);
        Assert.EndsWith("R0FURQ==", pix.QrImageDataUri);
        var calls = http.Calls.ToArray();
        Assert.All(calls, c => { Assert.Equal(Key, c.Token); Assert.False(c.Authorization, "a autenticação do Asaas é só access_token"); });
        var post = Assert.Single(calls, c => c.Method == "POST");
        Assert.Equal("/v3/payments", post.PathAndQuery);
        using var sent = JsonDocument.Parse(post.Body);
        Assert.Equal("PIX", sent.RootElement.GetProperty("billingType").GetString());
        Assert.Equal("ref-gate", sent.RootElement.GetProperty("externalReference").GetString());
        Assert.Equal("cus_gate", sent.RootElement.GetProperty("customer").GetString());
        Assert.Equal(39.90m, sent.RootElement.GetProperty("value").GetDecimal());
        Assert.Contains(calls, c => c is { Method: "GET", PathAndQuery: "/v3/payments/pay_gate/pixQrCode" });
    }

    [Theory]
    [InlineData("19.99", 1999)]
    [InlineData("0.07", 7)]
    [InlineData("1234.56", 123456)]
    public async Task Value_becomes_cents_without_float_error(string value, long cents)
    {
        var (factory, http, _) = Api();
        await using var _f = factory;
        http.Respond = (_, _) => Task.FromResult(GateAsaasHttp.Json(Payment("PENDING", value)));
        using var scope = factory.Services.CreateScope();
        var charge = await Gateway(scope).GetChargeAsync("pay_gate", CancellationToken.None);
        Assert.Equal(cents, charge.AmountCents);
        Assert.Equal("BRL", charge.Currency);
        Assert.Equal("ref-gate", charge.ExternalReference);
        Assert.Equal("cus_gate", charge.ExternalCustomerId);
        Assert.Contains(http.Calls, c => c is { Method: "GET", PathAndQuery: "/v3/payments/pay_gate" });
    }

    [Theory]
    [InlineData("RECEIVED", false, BillingChargeStatus.Paid)]
    [InlineData("CONFIRMED", false, BillingChargeStatus.Paid)]
    [InlineData("PENDING", false, BillingChargeStatus.Pending)]
    [InlineData("OVERDUE", false, BillingChargeStatus.Expired)]
    [InlineData("PENDING", true, BillingChargeStatus.Expired)]
    [InlineData("REFUNDED", false, BillingChargeStatus.Refunded)]
    public async Task Asaas_status_maps_to_the_canonical_vocabulary(string status, bool deleted, BillingChargeStatus expected)
    {
        var (factory, http, _) = Api();
        await using var _f = factory;
        http.Respond = (_, _) => Task.FromResult(GateAsaasHttp.Json(Payment(status, deleted: deleted)));
        using var scope = factory.Services.CreateScope();
        Assert.Equal(expected, (await Gateway(scope).GetChargeAsync("pay_gate", CancellationToken.None)).Status);
    }

    [Fact]
    public async Task Find_by_reference_uses_the_query_and_tolerates_nothing_found()
    {
        var (factory, http, _) = Api();
        await using var _f = factory;
        http.Respond = (_, _) => Task.FromResult(GateAsaasHttp.Json("""{"object":"list","hasMore":false,"totalCount":0,"data":[]}"""));
        using var scope = factory.Services.CreateScope();
        Assert.Null(await Gateway(scope).FindChargeByReferenceAsync("ref-gate", CancellationToken.None));
        Assert.Contains(http.Calls, c => c is { Method: "GET", PathAndQuery: "/v3/payments?externalReference=ref-gate" });
    }

    [Fact]
    public async Task Customer_goes_with_the_document_and_the_document_never_reaches_logs()
    {
        var (factory, http, logs) = Api();
        await using var _f = factory;
        http.Respond = (request, _) => Task.FromResult(GateAsaasHttp.Json(request.Method == HttpMethod.Post
            ? """{"object":"customer","id":"cus_novo"}""" : """{"object":"list","totalCount":0,"data":[]}"""));
        using var scope = factory.Services.CreateScope();
        var customer = await Gateway(scope).EnsureCustomerAsync(new GatewayCustomerRequest("cliente-gate", "Empresa Gate", TaxId, "f@example.test"), CancellationToken.None);
        Assert.Equal("cus_novo", customer.ExternalCustomerId);
        var post = Assert.Single(http.Calls, c => c.Method == "POST");
        Assert.Equal("/v3/customers", post.PathAndQuery);
        Assert.Equal(TaxId, JsonDocument.Parse(post.Body).RootElement.GetProperty("cpfCnpj").GetString());
        Assert.DoesNotContain(TaxId, logs.All);
        Assert.DoesNotContain(Key, logs.All);
    }

    [Fact]
    public async Task Refund_posts_once_with_the_value()
    {
        var (factory, http, _) = Api();
        await using var _f = factory;
        http.Respond = (_, _) => Task.FromResult(GateAsaasHttp.Json(Payment("REFUNDED")));
        using var scope = factory.Services.CreateScope();
        await Gateway(scope).RefundAsync("pay_gate", 3900, "arrependimento", CancellationToken.None);
        // GETs conferem estorno retido no Asaas (specs/BIL-007.md); o POST continua único.
        var post = Assert.Single(http.Calls, c => c.Method == "POST");
        Assert.Equal("/v3/payments/pay_gate/refund", post.PathAndQuery);
    }

    [Fact]
    public async Task Refund_post_has_its_own_timeout()
    {
        var (factory, http, _) = Api();
        await using var _f = factory;
        http.Respond = async (request, ct) =>
        {
            if (request.Method == HttpMethod.Post) await Task.Delay(Timeout.Infinite, ct);
            return GateAsaasHttp.Json(Payment("RECEIVED"));
        };
        using var scope = factory.Services.CreateScope();
        var watch = Stopwatch.StartNew();
        await Assert.ThrowsAnyAsync<Exception>(() => Gateway(scope).RefundAsync("pay_gate", 3900, "arrependimento", CancellationToken.None))
            .WaitAsync(TimeSpan.FromSeconds(25));
        Assert.InRange(watch.Elapsed.TotalSeconds, 6.5, 12);
        Assert.Single(http.Calls, c => c.Method == "POST");
    }

    [Fact]
    public async Task Post_is_never_retried_on_failure()
    {
        var (factory, http, _) = Api();
        await using var _f = factory;
        http.Respond = (_, _) => Task.FromResult(GateAsaasHttp.Json("{}", HttpStatusCode.ServiceUnavailable));
        using var scope = factory.Services.CreateScope();
        await Assert.ThrowsAnyAsync<Exception>(() => Gateway(scope).CreatePixChargeAsync(PixRequest(), CancellationToken.None));
        Assert.Single(http.Calls, c => c.Method == "POST");
    }

    // CancellationToken.None de propósito: é o que o processador passa, e o tempo limite precisa ser do gateway.
    [Fact]
    public async Task Every_call_has_its_own_timeout_of_about_eight_seconds()
    {
        var (factory, http, _) = Api();
        await using var _f = factory;
        http.Respond = async (_, ct) => { await Task.Delay(Timeout.Infinite, ct); return GateAsaasHttp.Json("{}"); };
        using var scope = factory.Services.CreateScope();
        async Task<double> Timed(Func<Task> call)
        {
            var watch = Stopwatch.StartNew();
            await Assert.ThrowsAnyAsync<Exception>(call).WaitAsync(TimeSpan.FromSeconds(25));
            return watch.Elapsed.TotalSeconds;
        }
        var gateway = Gateway(scope);
        var times = await Task.WhenAll(
            Timed(() => gateway.GetChargeAsync("pay_gate", CancellationToken.None)),
            Timed(() => gateway.CreatePixChargeAsync(PixRequest(), CancellationToken.None)),
            Timed(() => gateway.RefundAsync("pay_gate", 3900, "arrependimento", CancellationToken.None)));
        Assert.All(times, seconds => Assert.InRange(seconds, 6.5, 12));
        // Com tudo travado, o estorno para no GET de conferência; o POST dele tem caso próprio acima.
        Assert.Single(http.Calls, c => c.Method == "POST");
    }
}
