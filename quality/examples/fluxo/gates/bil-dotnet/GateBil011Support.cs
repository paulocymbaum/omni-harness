// Gates BIL-011. Template do autor de gates. Emissão de NFS-e pelo gateway real sobre o Asaas de mentira, com configuração fictícia só deste arquivo.
// Inscrição municipal, alíquota e prefeitura ficam em BIL-011-SANDBOX-NFSE, manual. A lista de tipos usa reflexão: o emissor não tem caminho fixo aqui.
using System.Net;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Fluxo.Api.Tests;

internal sealed record GateFiscalState(GateFakeAsaas Fake, GateClock Clock, DebateApiFactory Factory, GateAuto State, HttpClient Hook, string Payment);

internal static class GateFiscal
{
    public const string Job = "--job=billing-reconcile";

    public static readonly (string Key, string? Value)[] Complete =
    [
        ("Billing:Fiscal:Enabled", "true"), ("Billing:Fiscal:MunicipalServiceCode", "gate-servico"), ("Billing:Fiscal:MunicipalServiceName", "Serviço Gate"),
        ("Billing:Fiscal:ServiceDescription", "Assinatura Gate"), ("Billing:Fiscal:Taxes:retainIss", "false"), ("Billing:Fiscal:Taxes:gateCampo", "gate-valor"),
    ];

    public static async Task<GateFiscalState> PaidAsync(GateLogs? logs = null, bool enabled = true, params (string Key, string? Value)[] extra)
    {
        await GateRecurrence.QuietAsync();
        await DebateTestDb.ExecAsync(GateBil.C, "DO $$ BEGIN IF to_regclass('fluxo.billing_fiscal_documents') IS NOT NULL THEN UPDATE fluxo.billing_fiscal_documents SET status='error' WHERE status='pending'; END IF; END $$");
        var (fake, clock) = (new GateFakeAsaas(), new GateClock(GateRecurrence.Noon()));
        var factory = GateRecurrence.Api(fake, clock, automatic: false, more: logs is null ? null : s => s.AddSingleton<ILoggerProvider>(logs), extra: [.. enabled ? Complete : [], .. extra]);
        var (id, owner, subscription, invoice, client) = await GateRecurrence.SubscribeAsync(factory);
        using (var charged = await GateCheckout.ChargeAsync(client, invoice, $"chave-{Guid.NewGuid():N}")) await GateBil.JsonAsync(charged);
        var payment = fake.Payments.Keys.Single();
        var hook = factory.CreateClient();
        fake.Pay(payment);
        await GateRecurrence.EventAsync(hook, "PAYMENT_RECEIVED", "payment", new { id = payment });
        Assert.Equal("paid", await GateCheckout.InvoiceStatus(invoice));
        return new GateFiscalState(fake, clock, factory, new GateAuto(id, owner, subscription, invoice, "", "", GateRecurrence.Value, client), hook, payment);
    }

    public static Task<string?> Column(Guid invoice, string column) => GateCheckout.Text($"SELECT {column}::text FROM fluxo.billing_fiscal_documents WHERE invoice_id='{invoice}'");
    public static Task<long> Documents(Guid invoice) => GateRecurrence.Count($"SELECT count(*) FROM fluxo.billing_fiscal_documents WHERE invoice_id='{invoice}'");
    public static Task EmitAsync(GateFiscalState s) => GateRecurrence.RunAsync(s.Factory, Job);
    public static Task<string> EventAsync(GateFiscalState s, string type, string external, string? payment = null, string? id = null) =>
        GateRecurrence.EventAsync(s.Hook, type, "invoice", new { id = external, payment = payment ?? s.Payment }, id);

    /// <summary>Emite e devolve a nota criada no Asaas.</summary>
    public static async Task<GateFakeAsaas.Invoice> EmittedAsync(GateFiscalState s)
    {
        await EmitAsync(s);
        Assert.True(s.Fake.Invoices.Count == 1, $"billing-reconcile criou {s.Fake.Invoices.Count} notas em POST /v3/invoices; esperava 1");
        return s.Fake.Invoices.Values.Single();
    }
}
