// Apoio dos gates BIL-009. Template do autor de gates. Monta por SQL uma empresa com assinatura, fatura, cobrança e eventos de webhook.
// O cliente passa pela rota de BIL-005, para máscara, HMAC e ciphertext serem os reais.
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Fluxo.Api.Tests;

internal sealed record GateLedger(string BusinessId, string Owner, Guid Customer, Guid Subscription, Guid Invoice, Guid Charge, string ExternalCharge, Guid QuarantinedEvent, Guid ProcessedEvent, string Marker);

internal static class GateAdmin
{
    public const string Base = "/api/v1/admin/billing";
    public const string Reason = "Conciliação feita pelo financeiro";
    public const string RawTaxId = "12ABC34501DE35";
    public const string TypedTaxId = "12.ABC.345/01DE-35";
    public const string Mask = "**.***.345/****-35";

    public static HttpClient Client(DebateApiFactory factory, string role, int age, params string[] permissions)
    {
        var uid = $"admin-{Guid.NewGuid():N}";
        factory.Registry.Grant(uid, role, permissions);
        return factory.Client(DebateApiFactory.Admin(uid, role, age));
    }

    public static HttpClient Client(DebateApiFactory factory, params string[] permissions) => Client(factory, "admin", 60, permissions);

    /// <summary>client_key nasce em BIL-007 e pode ser obrigatória: entra só se a coluna existir.</summary>
    private static async Task<(string Columns, string Values)> ChargeExtrasAsync(Guid charge)
    {
        var exists = await DebateTestDb.ScalarAsync<long>(GateBil.C,
            "SELECT count(*) FROM information_schema.columns WHERE table_schema='fluxo' AND table_name='billing_charges' AND column_name='client_key'");
        return exists > 0 ? (",client_key", $",'{charge}'") : ("", "");
    }

    public static async Task<GateLedger> SeedAsync(DebateApiFactory factory, string invoiceStatus = "open", string chargeStatus = "pending", string subscriptionStatus = "incomplete")
    {
        await GateBil.ApplyMvpAsync();
        var (id, owner) = await GateBil.SeedBusinessAsync();
        using (var client = factory.Client($"user:{owner}")) await GateCheckout.PutFiscalAsync(client, id);
        var customer = await DebateTestDb.ScalarAsync<Guid>(GateBil.C, $"SELECT id FROM fluxo.billing_customers WHERE subject_id='{id}'");
        var (subscription, invoice, charge, quarantined, processed) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        var (external, marker) = ($"pay_{Guid.NewGuid():N}", $"corpo-cru-{Guid.NewGuid():N}");
        var (columns, values) = await ChargeExtrasAsync(charge);
        var raw = "{\"marker\":\"" + marker + "\"}";
        await DebateTestDb.ExecAsync(GateBil.C, $"""
            INSERT INTO fluxo.billing_subscriptions(id,customer_id,product_id,status,rail,quantity,cancel_at_period_end,created_at,updated_at,version)
            VALUES ('{subscription}','{customer}','b1000000-0000-4000-8000-000000000002','{subscriptionStatus}','pix_manual',1,false,now(),now(),0);
            INSERT INTO fluxo.billing_invoices(id,subscription_id,customer_id,subtotal_cents,total_cents,status,created_at,updated_at)
            VALUES ('{invoice}','{subscription}','{customer}',3900,3900,'{invoiceStatus}',now(),now());
            INSERT INTO fluxo.billing_charges(id,invoice_id,rail,amount_cents,status,attempt_number,external_charge_id,created_at,updated_at{columns})
            VALUES ('{charge}','{invoice}','pix_manual',3900,'{chargeStatus}',1,'{external}',now(),now(){values});
            INSERT INTO fluxo.billing_webhook_events(id,provider,provider_event_id,event_type,raw_body,received_at,status,attempts,last_error,external_charge_id) VALUES
              ('{quarantined}','asaas','evt_{quarantined:N}','PAYMENT_RECEIVED','{raw}',now(),'quarantined',3,'amount_mismatch','{external}'),
              ('{processed}','asaas','evt_{processed:N}','PAYMENT_RECEIVED','{raw}',now(),'processed',1,NULL,'{external}');
            """);
        return new GateLedger(id, owner, customer, subscription, invoice, charge, external, quarantined, processed, marker);
    }

    public static Task<HttpResponseMessage> PostAsync(HttpClient client, string route, object body) =>
        DebateApiFactory.SendAsync(client, HttpMethod.Post, $"{Base}{route}", body);

    /// <summary>Só a trilha das telas: o seed passa por PUT customer, que tem auditoria própria.</summary>
    public static Task<long> AuditAsync(GateLedger ledger, string? fragment = null) => DebateTestDb.ScalarAsync<long>(GateBil.C,
        $"SELECT count(*) FROM fluxo.billing_audit_events e WHERE e.subject_id='{ledger.BusinessId}' AND e.action <> 'customer.updated'{(fragment is null ? "" : $" AND to_jsonb(e)::text ILIKE '%{fragment}%'")}");

    public static string[] ReadRoutes(GateLedger l) =>
    [
        $"{Base}/subscriptions", $"{Base}/subscriptions/{l.Subscription}", $"{Base}/invoices", $"{Base}/invoices/{l.Invoice}", $"{Base}/webhooks", $"{Base}/health",
    ];
}
