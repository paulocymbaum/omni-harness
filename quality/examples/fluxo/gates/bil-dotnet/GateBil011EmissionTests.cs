// Gates BIL-011. Template do autor de gates. Emissão de NFS-e pelo gateway real sobre o Asaas de mentira, com configuração fictícia só deste arquivo.
// Inscrição municipal, alíquota e prefeitura ficam em BIL-011-SANDBOX-NFSE, manual. A lista de tipos usa reflexão: o emissor não tem caminho fixo aqui.
using System.Net;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Fluxo.Api.Tests;

[Collection("GateBilSerial")]
public sealed class GateBil011EmissionTests
{
    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Paid_invoice_gets_one_pending_document_and_the_job_emits_with_the_contract_body()
    {
        var s = await GateFiscal.PaidAsync();
        await using var _f = s.Factory;
        using var _c = s.State.Client;
        using var _h = s.Hook;
        Assert.Equal("pending", await GateFiscal.Column(s.State.Invoice, "status"));
        Assert.Empty(s.Fake.Invoices);
        await GateFiscal.EmitAsync(s);
        var body = JsonDocument.Parse(Assert.Single(s.Fake.Posts("/v3/invoices")).Body).RootElement;
        Assert.Equal(s.Payment, body.GetProperty("payment").GetString());
        Assert.Equal(await GateFiscal.Column(s.State.Invoice, "id"), body.GetProperty("externalReference").GetString());
        Assert.Equal(GateRecurrence.Value, body.GetProperty("value").GetDecimal());
        Assert.Equal(0m, body.GetProperty("deductions").GetDecimal());
        Assert.Equal(GateRecurrence.Date(s.Clock.Now), body.GetProperty("effectiveDate").GetString());
        Assert.Equal("Assinatura Gate", body.GetProperty("serviceDescription").GetString());
        Assert.True(body.TryGetProperty("observations", out _));
        Assert.Equal("Serviço Gate", body.GetProperty("municipalServiceName").GetString());
        Assert.Equal("gate-servico", body.GetProperty("municipalServiceCode").GetString());
        // Binder de configuração não preenche JsonElement: o bloco precisa chegar de verdade, com os campos configurados.
        Assert.Equal("gate-valor", body.GetProperty("taxes").GetProperty("gateCampo").GetString());
        Assert.True(body.GetProperty("taxes").TryGetProperty("retainIss", out _));
        Assert.Equal("scheduled", await GateFiscal.Column(s.State.Invoice, "status"));
        Assert.Equal(s.Fake.Invoices.Keys.Single(), await GateFiscal.Column(s.State.Invoice, "external_id"));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Offset_of_the_effective_date_comes_from_configuration()
    {
        var s = await GateFiscal.PaidAsync(extra: ("Billing:Fiscal:EffectiveDateOffsetDays", "2"));
        await using var _f = s.Factory;
        using var _c = s.State.Client;
        using var _h = s.Hook;
        await GateFiscal.EmitAsync(s);
        var body = JsonDocument.Parse(Assert.Single(s.Fake.Posts("/v3/invoices")).Body).RootElement;
        Assert.Equal(GateRecurrence.Date(s.Clock.Now.AddDays(2)), body.GetProperty("effectiveDate").GetString());
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Repeated_event_and_repeated_job_make_one_document_and_one_note()
    {
        var s = await GateFiscal.PaidAsync();
        await using var _f = s.Factory;
        using var _c = s.State.Client;
        using var _h = s.Hook;
        await GateRecurrence.EventAsync(s.Hook, "PAYMENT_CONFIRMED", "payment", new { id = s.Payment });
        for (var i = 0; i < 3; i++) await GateFiscal.EmitAsync(s);
        await GateRecurrence.EventAsync(s.Hook, "PAYMENT_RECEIVED", "payment", new { id = s.Payment });
        await GateFiscal.EmitAsync(s);
        Assert.Equal(1, await GateFiscal.Documents(s.State.Invoice));
        Assert.Single(s.Fake.Invoices);
        Assert.Contains("invoice_id", await GateCheckout.Text("SELECT indexdef FROM pg_indexes WHERE schemaname='fluxo' AND tablename='billing_fiscal_documents' AND indexdef ILIKE 'CREATE UNIQUE%invoice_id%'"));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Failure_after_creating_resumes_without_a_second_note()
    {
        var s = await GateFiscal.PaidAsync();
        await using var _f = s.Factory;
        using var _c = s.State.Client;
        using var _h = s.Hook;
        s.Fake.InvoiceLostAfterCreate = true;
        await GateFiscal.EmitAsync(s);
        Assert.Equal("pending", await GateFiscal.Column(s.State.Invoice, "status"));
        await GateFiscal.EmitAsync(s);
        Assert.Single(s.Fake.Invoices);
        Assert.Single(s.Fake.Posts("/v3/invoices"));
        Assert.Equal("scheduled", await GateFiscal.Column(s.State.Invoice, "status"));
        Assert.Equal(s.Fake.Invoices.Keys.Single(), await GateFiscal.Column(s.State.Invoice, "external_id"));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Disabled_uses_the_noop_issuer_writes_nothing_and_turning_it_on_is_not_retroactive()
    {
        var s = await GateFiscal.PaidAsync(enabled: false);
        await using var _f = s.Factory;
        using var _c = s.State.Client;
        using var _h = s.Hook;
        using (var scope = s.Factory.Services.CreateScope())
            Assert.Equal("NoopFiscalDocumentIssuer", scope.ServiceProvider.GetRequiredService(GateBil.Find("IFiscalDocumentIssuer")).GetType().Name);
        await GateFiscal.EmitAsync(s);
        Assert.Equal(0, await GateFiscal.Documents(s.State.Invoice));
        Assert.Empty(s.Fake.Http.Calls.Where(c => c.PathAndQuery.StartsWith("/v3/invoices", StringComparison.Ordinal)));
        await using var on = GateRecurrence.Api(s.Fake, s.Clock, automatic: false, extra: GateFiscal.Complete);
        await GateRecurrence.RunAsync(on, GateFiscal.Job);
        Assert.Equal(0, await GateFiscal.Documents(s.State.Invoice));
    }

    [Theory, Trait("Category", "PostgresIntegration")]
    [InlineData("manual", 3900)]
    [InlineData("pix_manual", 0)]
    public async Task Zero_value_and_manual_plan_generate_no_document(string rail, long cents)
    {
        await GateRecurrence.QuietAsync();
        var (fake, clock) = (new GateFakeAsaas(), new GateClock(GateRecurrence.Noon()));
        await using var factory = GateRecurrence.Api(fake, clock, automatic: false, extra: GateFiscal.Complete);
        var (_, _, subscription, invoice, client) = await GateRecurrence.SubscribeAsync(factory);
        using var _c = client;
        await DebateTestDb.ExecAsync(GateBil.C, $"""
            UPDATE fluxo.billing_subscriptions SET rail='{rail}' WHERE id='{subscription}';
            UPDATE fluxo.billing_invoices SET total_cents={cents}, subtotal_cents={cents} WHERE id='{invoice}';
            """);
        using (var charged = await GateCheckout.ChargeAsync(client, invoice, $"chave-{Guid.NewGuid():N}")) { }
        await DebateTestDb.ExecAsync(GateBil.C, $"UPDATE fluxo.billing_charges SET amount_cents={cents} WHERE invoice_id='{invoice}'");
        foreach (var payment in fake.Payments.Values)
        {
            payment.Value = cents / 100m;
            fake.Pay(payment.Id);
            using var hook = factory.CreateClient();
            await GateRecurrence.EventAsync(hook, "PAYMENT_RECEIVED", "payment", new { id = payment.Id });
        }
        await GateRecurrence.RunAsync(factory, GateFiscal.Job);
        Assert.Equal(0, await GateFiscal.Documents(invoice));
        Assert.Empty(fake.Invoices);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Provider_is_called_with_no_transaction_open()
    {
        const string application = "gate-bil011-psp";
        await GateRecurrence.QuietAsync();
        var (fake, clock) = (new GateFakeAsaas { ProbeApplication = application }, new GateClock(GateRecurrence.Noon()));
        await using var factory = GateRecurrence.Api(fake, clock, GateProbe.Connection(application), automatic: false, extra: GateFiscal.Complete);
        var (_, _, _, invoice, client) = await GateRecurrence.SubscribeAsync(factory);
        using var _c = client;
        using var hook = factory.CreateClient();
        using (var charged = await GateCheckout.ChargeAsync(client, invoice, $"chave-{Guid.NewGuid():N}")) await GateBil.JsonAsync(charged);
        var payment = fake.Payments.Keys.Single();
        fake.Pay(payment);
        await GateRecurrence.EventAsync(hook, "PAYMENT_RECEIVED", "payment", new { id = payment });
        await GateRecurrence.RunAsync(factory, GateFiscal.Job);
        Assert.Single(fake.Invoices);
        Assert.Empty(fake.Violations);
    }
}
