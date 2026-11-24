// Gates BIL-011. Template do autor de gates. Emissão de NFS-e pelo gateway real sobre o Asaas de mentira, com configuração fictícia só deste arquivo.
// Inscrição municipal, alíquota e prefeitura ficam em BIL-011-SANDBOX-NFSE, manual. A lista de tipos usa reflexão: o emissor não tem caminho fixo aqui.
using System.Net;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Fluxo.Api.Tests;

[Collection("GateBilSerial")]
public sealed class GateBil011FailureTests
{
    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Fiscal_error_changes_neither_subscription_nor_invoice_nor_plan()
    {
        var s = await GateFiscal.PaidAsync();
        await using var _f = s.Factory;
        using var _c = s.State.Client;
        using var _h = s.Hook;
        var route = $"/api/v1/billing/subjects/business/{s.State.BusinessId}/entitlements";
        using var before = await s.State.Client.GetAsync(route);
        var plan = (await GateBil.JsonAsync(before)).GetProperty("planCode").GetString();
        var note = await GateFiscal.EmittedAsync(s);
        note.Status = "ERROR";
        await GateFiscal.EventAsync(s, "INVOICE_ERROR", note.Id);
        Assert.Equal("error", await GateFiscal.Column(s.State.Invoice, "status"));
        Assert.Equal("active", await GateCheckout.SubscriptionStatus(s.State.Subscription));
        Assert.Equal("paid", await GateCheckout.InvoiceStatus(s.State.Invoice));
        using var after = await s.State.Client.GetAsync(route);
        Assert.Equal(plan, (await GateBil.JsonAsync(after)).GetProperty("planCode").GetString());
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Five_network_failures_exhaust_the_attempts_without_touching_the_plan_or_logging_personal_data()
    {
        var logs = new GateLogs();
        var s = await GateFiscal.PaidAsync(logs);
        await using var _f = s.Factory;
        using var _c = s.State.Client;
        using var _h = s.Hook;
        s.Fake.InvoicesDown = true;
        for (var i = 0; i < 4; i++) await GateFiscal.EmitAsync(s);
        Assert.Equal("pending", await GateFiscal.Column(s.State.Invoice, "status"));
        await GateFiscal.EmitAsync(s);
        Assert.Equal("error", await GateFiscal.Column(s.State.Invoice, "status"));
        Assert.Equal("5", await GateFiscal.Column(s.State.Invoice, "attempts"));
        Assert.Equal("billing_fiscal_attempts_exhausted", await GateFiscal.Column(s.State.Invoice, "error_code"));
        var calls = s.Fake.Http.Calls.Count(c => c.PathAndQuery.StartsWith("/v3/invoices", StringComparison.Ordinal));
        await GateFiscal.EmitAsync(s);
        Assert.Equal(calls, s.Fake.Http.Calls.Count(c => c.PathAndQuery.StartsWith("/v3/invoices", StringComparison.Ordinal)));
        Assert.Equal("active", await GateCheckout.SubscriptionStatus(s.State.Subscription));
        foreach (var secret in new[] { "Empresa Gate LTDA", "12ABC34501DE35", "12.ABC.345/01DE-35", "financeiro@example.test" })
            Assert.DoesNotContain(secret, logs.All, StringComparison.Ordinal);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Admin_retry_returns_to_pending_with_permission_reason_audit_and_no_provider_call()
    {
        var s = await GateFiscal.PaidAsync();
        await using var _f = s.Factory;
        using var _c = s.State.Client;
        using var _h = s.Hook;
        var note = await GateFiscal.EmittedAsync(s);
        note.Status = "ERROR";
        await GateFiscal.EventAsync(s, "INVOICE_ERROR", note.Id);
        var document = await GateFiscal.Column(s.State.Invoice, "id");
        var route = $"{GateAdmin.Base}/fiscal-documents/{document}/retry";
        using var reader = GateAdmin.Client(s.Factory, "billing.read");
        using (var denied = await GateAdmin.PostAsync(reader, $"/fiscal-documents/{document}/retry", new { reason = GateAdmin.Reason })) Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        using var stale = GateAdmin.Client(s.Factory, "admin", 7200, "billing.manage");
        using (var old = await GateAdmin.PostAsync(stale, $"/fiscal-documents/{document}/retry", new { reason = GateAdmin.Reason })) Assert.False(old.IsSuccessStatusCode, "login antigo não pode reenviar");
        using var manager = GateAdmin.Client(s.Factory, "billing.manage");
        using (var noReason = await GateAdmin.PostAsync(manager, $"/fiscal-documents/{document}/retry", new { reason = "curto" })) Assert.False(noReason.IsSuccessStatusCode, "motivo é obrigatório");
        var calls = s.Fake.Http.Calls.Count;
        var audits = await GateCheckout.AuditCountAsync(s.State.BusinessId);
        using (var done = await GateAdmin.PostAsync(manager, $"/fiscal-documents/{document}/retry", new { reason = GateAdmin.Reason })) Assert.True(done.IsSuccessStatusCode, await done.Content.ReadAsStringAsync());
        Assert.Equal(calls, s.Fake.Http.Calls.Count);
        Assert.Equal("pending", await GateFiscal.Column(s.State.Invoice, "status"));
        Assert.Equal(audits + 1, await GateCheckout.AuditCountAsync(s.State.BusinessId));
    }
}
