// Gates BIL-011. Template do autor de gates. Emissão de NFS-e pelo gateway real sobre o Asaas de mentira, com configuração fictícia só deste arquivo.
// Inscrição municipal, alíquota e prefeitura ficam em BIL-011-SANDBOX-NFSE, manual. A lista de tipos usa reflexão: o emissor não tem caminho fixo aqui.
using System.Net;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Fluxo.Api.Tests;

[Collection("GateBilSerial")]
public sealed class GateBil011EventTests
{
    [Theory, Trait("Category", "PostgresIntegration")]
    [InlineData("INVOICE_CREATED", "SCHEDULED", "scheduled")]
    [InlineData("INVOICE_SYNCHRONIZED", "SYNCHRONIZED", "synchronized")]
    [InlineData("INVOICE_PROCESSING_CANCELLATION", "PROCESSING_CANCELLATION", "processing_cancellation")]
    [InlineData("INVOICE_CANCELED", "CANCELED", "canceled")]
    [InlineData("INVOICE_CANCELLATION_DENIED", "CANCELLATION_DENIED", "cancellation_denied")]
    public async Task Each_event_applies_the_consulted_state(string type, string remote, string local)
    {
        var s = await GateFiscal.PaidAsync();
        await using var _f = s.Factory;
        using var _c = s.State.Client;
        using var _h = s.Hook;
        var note = await GateFiscal.EmittedAsync(s);
        note.Status = remote;
        var id = await GateFiscal.EventAsync(s, type, note.Id);
        Assert.Equal("processed", await GateCheckout.EventStatus(id));
        Assert.Equal(local, await GateFiscal.Column(s.State.Invoice, "status"));
        Assert.Contains(s.Fake.Http.Calls, c => c is { Method: "GET" } && c.PathAndQuery == $"/v3/invoices/{note.Id}");
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Authorized_records_number_and_links_and_the_portal_sees_the_link_only_then()
    {
        var s = await GateFiscal.PaidAsync();
        await using var _f = s.Factory;
        using var _c = s.State.Client;
        using var _h = s.Hook;
        var note = await GateFiscal.EmittedAsync(s);
        var route = $"/api/v1/billing/invoices/{s.State.Invoice}";
        using (var early = await s.State.Client.GetAsync(route))
            Assert.Equal(JsonValueKind.Null, (await GateBil.JsonAsync(early)).GetProperty("invoice").GetProperty("fiscalPdfUrl").ValueKind);
        (note.Status, note.Number, note.PdfUrl, note.XmlUrl) = ("AUTHORIZED", "2026-77", "https://asaas.gate.invalid/nf.pdf", "https://asaas.gate.invalid/nf.xml");
        await GateFiscal.EventAsync(s, "INVOICE_AUTHORIZED", note.Id);
        Assert.Equal("authorized", await GateFiscal.Column(s.State.Invoice, "status"));
        Assert.Equal("2026-77", await GateFiscal.Column(s.State.Invoice, "number"));
        Assert.Equal(note.PdfUrl, await GateFiscal.Column(s.State.Invoice, "pdf_url"));
        Assert.Equal(note.XmlUrl, await GateFiscal.Column(s.State.Invoice, "xml_url"));
        Assert.NotNull(await GateFiscal.Column(s.State.Invoice, "authorized_at"));
        using var late = await s.State.Client.GetAsync(route);
        Assert.Equal(note.PdfUrl, (await GateBil.JsonAsync(late)).GetProperty("invoice").GetProperty("fiscalPdfUrl").GetString());
    }

    [Theory, Trait("Category", "PostgresIntegration")]
    [InlineData("payment")]
    [InlineData("reference")]
    public async Task Divergence_from_the_local_document_goes_to_quarantine(string field)
    {
        var s = await GateFiscal.PaidAsync();
        await using var _f = s.Factory;
        using var _c = s.State.Client;
        using var _h = s.Hook;
        var note = await GateFiscal.EmittedAsync(s);
        if (field == "payment") note.Payment = "pay_de_outra_empresa"; else note.ExternalReference = Guid.NewGuid().ToString();
        note.Status = "AUTHORIZED";
        var id = await GateFiscal.EventAsync(s, "INVOICE_AUTHORIZED", note.Id);
        Assert.Equal("quarantined", await GateCheckout.EventStatus(id));
        Assert.Equal("scheduled", await GateFiscal.Column(s.State.Invoice, "status"));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Out_of_order_events_follow_the_consulted_state_and_repeating_changes_nothing()
    {
        var s = await GateFiscal.PaidAsync();
        await using var _f = s.Factory;
        using var _c = s.State.Client;
        using var _h = s.Hook;
        var note = await GateFiscal.EmittedAsync(s);
        note.Status = "AUTHORIZED";
        var authorized = await GateFiscal.EventAsync(s, "INVOICE_AUTHORIZED", note.Id);
        await GateFiscal.EventAsync(s, "INVOICE_CREATED", note.Id);
        await GateFiscal.EventAsync(s, "INVOICE_AUTHORIZED", note.Id, id: authorized);
        Assert.Equal("authorized", await GateFiscal.Column(s.State.Invoice, "status"));
        Assert.Equal(1, await GateRecurrence.Count($"SELECT count(*) FROM fluxo.billing_webhook_events WHERE provider_event_id='{authorized}'"));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Admin_list_shows_the_fiscal_state_under_billing_read()
    {
        var s = await GateFiscal.PaidAsync();
        await using var _f = s.Factory;
        using var _c = s.State.Client;
        using var _h = s.Hook;
        var note = await GateFiscal.EmittedAsync(s);
        note.Status = "ERROR";
        await GateFiscal.EventAsync(s, "INVOICE_ERROR", note.Id);
        await DebateTestDb.ExecAsync(GateBil.C, $"UPDATE fluxo.billing_fiscal_documents SET error_code='E_GATE', number='N-1' WHERE invoice_id='{s.State.Invoice}'");
        var uid = $"admin-{Guid.NewGuid():N}";
        s.Factory.Registry.Grant(uid, "admin", "billing.read");
        using var admin = s.Factory.Client(DebateApiFactory.Admin(uid));
        using var response = await admin.GetAsync("/api/v1/admin/billing/invoices");
        var row = (await GateBil.JsonAsync(response)).GetProperty("items").EnumerateArray().First(x => x.GetProperty("id").GetGuid() == s.State.Invoice);
        Assert.Equal("error", row.GetProperty("fiscalStatus").GetString());
        Assert.Equal("E_GATE", row.GetProperty("fiscalErrorCode").GetString());
        Assert.Equal("N-1", row.GetProperty("fiscalNumber").GetString());
        Assert.True(row.TryGetProperty("fiscalErrorMessage", out _));
    }
}
