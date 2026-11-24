// Gate BIL-007-PSP-FORA-DA-TRANSACAO. Template do autor de gates. Duas provas: CurrentTransaction do DbContext da requisição e
// pg_stat_activity pelo Application Name, que pega também transação aberta por outro contexto ou escopo.
using System.Net;
using Npgsql;

namespace Fluxo.Api.Tests;

[Collection("GateBilSerial")]
public sealed class GateBil007TransactionTests
{
    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Sensor_sees_a_transaction_left_open()
    {
        await DebateTestDb.EnsureAsync();
        var application = $"gate-{Guid.NewGuid():N}"[..30];
        await using var conn = new NpgsqlConnection(GateProbe.Connection(application));
        await conn.OpenAsync();
        Assert.Null(await GateProbe.OpenTransactionAsync(application));
        await using var transaction = await conn.BeginTransactionAsync();
        await using (var cmd = new NpgsqlCommand("SELECT 1", conn)) await cmd.ExecuteScalarAsync();
        Assert.NotNull(await GateProbe.OpenTransactionAsync(application));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Checkout_calls_the_psp_with_no_transaction_open()
    {
        var application = $"gate-{Guid.NewGuid():N}"[..30];
        var psp = new GatePsp { ProbeApplication = application };
        await using var factory = GateCheckout.Api(psp, GateProbe.Connection(application) + ";Pooling=true");
        await GateCheckout.OpenAsync(factory, psp);
        Assert.Equal(1, psp.Creates);
        Assert.True(psp.Customers >= 1, "EnsureCustomerAsync precisa rodar antes de criar a cobrança");
        Assert.Empty(psp.Violations);
        Assert.True(await DebateTestDb.ScalarAsync<long>(GateBil.C, $"SELECT count(*) FROM pg_stat_activity WHERE application_name='{application}'") > 0,
            "a sonda precisa enxergar as conexões da API");
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Webhook_reads_the_psp_with_no_transaction_open()
    {
        var application = $"gate-{Guid.NewGuid():N}"[..30];
        var psp = new GatePsp();
        await using var factory = GateCheckout.Api(psp, GateProbe.Connection(application) + ";Pooling=true");
        var state = await GateCheckout.OpenAsync(factory, psp);
        psp.MarkPaid(state.ExternalChargeId);
        psp.ProbeApplication = application;
        using var client = factory.CreateClient();
        await GateCheckout.WebhookAsync(client, state.ExternalChargeId);
        Assert.True(psp.Gets >= 1, "o webhook precisa consultar o PSP");
        Assert.Empty(psp.Violations);
        Assert.Equal("paid", await GateCheckout.InvoiceStatus(state.InvoiceId));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Charge_route_is_exempt_from_the_middleware_and_still_demands_the_key()
    {
        var psp = new GatePsp();
        await using var factory = GateCheckout.Api(psp);
        var state = await GateCheckout.OpenAsync(factory, psp);
        using var client = factory.Client($"user:{state.Owner}");
        using (var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/billing/invoices/{state.InvoiceId}/charges") { Content = System.Net.Http.Json.JsonContent.Create(new { }) })
        using (var missing = await client.SendAsync(request))
        {
            Assert.Equal(HttpStatusCode.BadRequest, missing.StatusCode);
            Assert.Equal("idempotency_key_required", await DebateApiFactory.CodeAsync(missing));
        }
        using (var tooLong = await GateCheckout.ChargeAsync(client, state.InvoiceId, new string('k', 129)))
            Assert.Equal(HttpStatusCode.BadRequest, tooLong.StatusCode);
        var key = $"isenta-{Guid.NewGuid():N}";
        using (var ok = await GateCheckout.ChargeAsync(client, state.InvoiceId, key)) await GateBil.JsonAsync(ok);
        Assert.Equal(0L, await DebateTestDb.ScalarAsync<long>(GateBil.C, $"SELECT count(*) FROM fluxo.idempotency_records WHERE key='{key}'"));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Subscription_route_stays_under_the_middleware()
    {
        var price = await GateCheckout.SeedPriceAsync();
        var (id, owner) = await GateBil.SeedBusinessAsync();
        var psp = new GatePsp();
        await using var factory = GateCheckout.Api(psp);
        using var client = factory.Client($"user:{owner}");
        await GateCheckout.PutFiscalAsync(client, id);
        var key = $"assinar-{Guid.NewGuid():N}";
        using (var first = await GateCheckout.SubscribeAsync(client, id, price, key)) Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        Assert.Equal(1L, await DebateTestDb.ScalarAsync<long>(GateBil.C, $"SELECT count(*) FROM fluxo.idempotency_records WHERE key='{key}'"));
        Assert.Equal(0, psp.Touches);
    }
}
