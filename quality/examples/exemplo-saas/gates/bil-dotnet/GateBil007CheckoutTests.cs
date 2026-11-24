// Gate BIL-007-CHECKOUT-IDEMPOTENTE. Template do autor de gates. Exige PostgreSQL: a unicidade só se prova sob concorrência real.
using System.Net;

namespace Fluxo.Api.Tests;

[Collection("GateBilSerial")]
public sealed class GateBil007CheckoutTests
{
    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Flag_off_answers_404_and_writes_nothing()
    {
        var price = await GateCheckout.SeedPriceAsync();
        var (id, owner) = await GateBil.SeedBusinessAsync();
        await using var factory = GateCheckout.Api(new GatePsp(), extra: ("Billing:CheckoutEnabled", "false"));
        using var client = factory.Client($"user:{owner}");
        await GateCheckout.PutFiscalAsync(client, id);
        using var response = await GateCheckout.SubscribeAsync(client, id, price);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        var count = await DebateTestDb.ScalarAsync<long>(GateBil.C,
            $"SELECT count(*) FROM fluxo.billing_subscriptions s JOIN fluxo.billing_customers c ON c.id=s.customer_id WHERE c.subject_id='{id}'");
        Assert.Equal(0L, count);
        // Controle: com a flag ligada a mesma chamada cria, então o 404 acima veio da flag, e não de rota ausente.
        await using var on = GateCheckout.Api(new GatePsp());
        using var enabled = on.Client($"user:{owner}");
        using var created = await GateCheckout.SubscribeAsync(enabled, id, price);
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task First_step_creates_incomplete_and_open_without_touching_the_psp()
    {
        var price = await GateCheckout.SeedPriceAsync(4500);
        var (id, owner) = await GateBil.SeedBusinessAsync();
        var psp = new GatePsp();
        await using var factory = GateCheckout.Api(psp);
        using var client = factory.Client($"user:{owner}");
        await GateCheckout.PutFiscalAsync(client, id);
        using var response = await GateCheckout.SubscribeAsync(client, id, price);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var body = await GateBil.JsonAsync(response);
        Assert.Equal(4500, body.GetProperty("amountCents").GetInt64());
        Assert.Equal("incomplete", body.GetProperty("status").GetString());
        Assert.True(body.TryGetProperty("renewsAt", out _), "resposta sem renewsAt");
        Assert.Equal("incomplete", await GateCheckout.SubscriptionStatus(body.GetProperty("subscriptionId").GetGuid()));
        Assert.Equal("open", await GateCheckout.InvoiceStatus(body.GetProperty("invoiceId").GetGuid()));
        Assert.Equal(0, psp.Touches);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Same_price_with_another_key_reuses_the_incomplete_subscription()
    {
        var price = await GateCheckout.SeedPriceAsync();
        var (id, owner) = await GateBil.SeedBusinessAsync();
        await using var factory = GateCheckout.Api(new GatePsp());
        using var client = factory.Client($"user:{owner}");
        await GateCheckout.PutFiscalAsync(client, id);
        using var first = await GateCheckout.SubscribeAsync(client, id, price);
        using var second = await GateCheckout.SubscribeAsync(client, id, price);
        Assert.Equal((await GateBil.JsonAsync(first)).GetProperty("subscriptionId").GetGuid(), (await GateBil.JsonAsync(second)).GetProperty("subscriptionId").GetGuid());
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Customer_without_fiscal_data_gets_409()
    {
        var price = await GateCheckout.SeedPriceAsync();
        var (id, owner) = await GateBil.SeedBusinessAsync();
        await using var factory = GateCheckout.Api(new GatePsp());
        using var client = factory.Client($"user:{owner}");
        using var response = await GateCheckout.SubscribeAsync(client, id, price);
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("billing_customer_incomplete", await DebateApiFactory.CodeAsync(response));
    }

    [Theory, Trait("Category", "PostgresIntegration")]
    [InlineData("status", "Suspended")]
    [InlineData("verification_status", "Revoked")]
    public async Task Blocked_business_gets_409(string column, string value)
    {
        var price = await GateCheckout.SeedPriceAsync();
        var (id, owner) = await GateBil.SeedBusinessAsync();
        await using var factory = GateCheckout.Api(new GatePsp());
        using var client = factory.Client($"user:{owner}");
        await GateCheckout.PutFiscalAsync(client, id);
        await DebateTestDb.ExecAsync(GateBil.C, $"UPDATE fluxo.businesses SET {column}='{value}' WHERE id='{id}'");
        using var response = await GateCheckout.SubscribeAsync(client, id, price);
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("billing_business_blocked", await DebateApiFactory.CodeAsync(response));
    }

    [Theory, Trait("Category", "PostgresIntegration")]
    [InlineData(3900, true, "organizer")]
    [InlineData(3900, false, "business")]
    [InlineData(0, true, "business")]
    public async Task Price_that_cannot_be_sold_is_refused_and_a_valid_one_is_accepted(long cents, bool active, string audience)
    {
        var price = await GateCheckout.SeedPriceAsync(cents, active: active, audience: audience);
        var (id, owner) = await GateBil.SeedBusinessAsync();
        await using var factory = GateCheckout.Api(new GatePsp());
        using var client = factory.Client($"user:{owner}");
        await GateCheckout.PutFiscalAsync(client, id);
        using (var refused = await GateCheckout.SubscribeAsync(client, id, price))
            Assert.InRange((int)refused.StatusCode, 400, 499);
        using var accepted = await GateCheckout.SubscribeAsync(client, id, await GateCheckout.SeedPriceAsync());
        Assert.Equal(HttpStatusCode.Created, accepted.StatusCode);
    }

    private static async Task<(DebateApiFactory Factory, GatePsp Psp, HttpClient Client, Guid Invoice, string Id)> FirstStepAsync(GatePsp psp, Action<Microsoft.Extensions.DependencyInjection.IServiceCollection>? more = null)
    {
        var price = await GateCheckout.SeedPriceAsync();
        var (id, owner) = await GateBil.SeedBusinessAsync();
        var factory = GateCheckout.Api(psp, more: more);
        var client = factory.Client($"user:{owner}");
        await GateCheckout.PutFiscalAsync(client, id);
        using var response = await GateCheckout.SubscribeAsync(client, id, price);
        return (factory, psp, client, (await GateBil.JsonAsync(response)).GetProperty("invoiceId").GetGuid(), id);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Same_key_twice_makes_one_remote_charge_and_returns_the_same_qr()
    {
        var (factory, psp, client, invoice, _) = await FirstStepAsync(new GatePsp());
        await using var _f = factory;
        var key = $"qr-{Guid.NewGuid():N}";
        using var first = await GateCheckout.ChargeAsync(client, invoice, key);
        using var second = await GateCheckout.ChargeAsync(client, invoice, key);
        var (a, b) = (await GateBil.JsonAsync(first), await GateBil.JsonAsync(second));
        Assert.Equal(1, psp.Creates);
        foreach (var field in new[] { "chargeId", "brCode", "qrImageDataUri", "status", "expiresAt" })
            Assert.Equal(a.GetProperty(field).ToString(), b.GetProperty(field).ToString());
        Assert.Equal("pending", a.GetProperty("status").GetString());
        Assert.Equal(3900, a.GetProperty("amountCents").GetInt64());
        Assert.False(string.IsNullOrEmpty(a.GetProperty("brCode").GetString()));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Concurrent_requests_with_one_key_make_one_remote_charge()
    {
        var (factory, psp, client, invoice, _) = await FirstStepAsync(new GatePsp { CreateDelay = TimeSpan.FromMilliseconds(300) });
        await using var _f = factory;
        var key = $"qr-{Guid.NewGuid():N}";
        var responses = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => GateCheckout.ChargeAsync(client, invoice, key)));
        var bodies = await Task.WhenAll(responses.Select(GateBil.JsonAsync));
        Assert.Equal(1, psp.Creates);
        Assert.Single(bodies.Select(b => b.GetProperty("brCode").GetString()).Distinct());
        Assert.Equal(1L, await DebateTestDb.ScalarAsync<long>(GateBil.C, $"SELECT count(*) FROM fluxo.billing_charges WHERE invoice_id='{invoice}'"));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Failure_after_remote_creation_resumes_by_reference_without_a_second_charge()
    {
        var (factory, psp, client, invoice, _) = await FirstStepAsync(new GatePsp { FailAfterCreate = true });
        await using var _f = factory;
        var key = $"qr-{Guid.NewGuid():N}";
        using (var failed = await GateCheckout.ChargeAsync(client, invoice, key))
        {
            Assert.Equal(HttpStatusCode.BadGateway, failed.StatusCode);
            Assert.Equal("billing_psp_unavailable", await DebateApiFactory.CodeAsync(failed));
        }
        Assert.Equal("pending", await GateCheckout.Text($"SELECT status FROM fluxo.billing_charges WHERE invoice_id='{invoice}'"));
        using var resumed = await GateCheckout.ChargeAsync(client, invoice, key);
        var body = await GateBil.JsonAsync(resumed);
        Assert.Equal(1, psp.Creates);
        Assert.True(psp.Finds >= 1, "a retomada passa por FindChargeByReferenceAsync");
        Assert.False(string.IsNullOrEmpty(body.GetProperty("brCode").GetString()), "a retomada devolve o QR");
        Assert.Equal(psp.Single(), await GateCheckout.Text($"SELECT external_charge_id FROM fluxo.billing_charges WHERE invoice_id='{invoice}'"));
    }

    [Theory, Trait("Category", "PostgresIntegration")]
    [InlineData("paid")]
    [InlineData("void")]
    public async Task Closed_invoice_refuses_a_new_charge(string status)
    {
        var (factory, psp, client, invoice, _) = await FirstStepAsync(new GatePsp());
        await using var _f = factory;
        await DebateTestDb.ExecAsync(GateBil.C, $"UPDATE fluxo.billing_invoices SET status='{status}' WHERE id='{invoice}'");
        using var response = await GateCheckout.ChargeAsync(client, invoice, $"qr-{Guid.NewGuid():N}");
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal(0, psp.Creates);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Another_person_cannot_charge_the_invoice()
    {
        // Quem não é dono cai no fallback do Firestore: exige o emulador.
        var (factory, psp, _, invoice, _) = await FirstStepAsync(new GatePsp(), GateBil.LegacyDirectoryOnEmulator());
        await using var _f = factory;
        using var stranger = factory.Client($"user:estranho-{Guid.NewGuid():N}");
        using var response = await GateCheckout.ChargeAsync(stranger, invoice, $"qr-{Guid.NewGuid():N}");
        Assert.InRange((int)response.StatusCode, 403, 404);
        Assert.Equal(0, psp.Touches);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Schema_has_the_client_key_columns_and_the_unique_index()
    {
        await DebateTestDb.EnsureAsync();
        var columns = await GateBil.RowsAsync(GateBil.C, "SELECT column_name FROM information_schema.columns WHERE table_schema='fluxo' AND table_name='billing_charges'");
        Assert.Empty(new[] { "client_key", "br_code", "qr_image_data_uri", "qr_expires_at" }.Except(columns));
        var indexes = await GateBil.RowsAsync(GateBil.C, "SELECT indexdef FROM pg_indexes WHERE schemaname='fluxo' AND tablename='billing_charges'");
        Assert.Contains(indexes, i => i.Contains("UNIQUE") && i.Contains("(invoice_id, client_key)"));
    }
}
