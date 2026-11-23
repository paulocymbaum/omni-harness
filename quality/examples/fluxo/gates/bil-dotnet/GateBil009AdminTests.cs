// Gate BIL-009-DOTNET-TESTES. Template do autor de gates. Autorização e regras das telas administrativas por HTTP, resultado por SQL.
using System.Net;
using Fluxo.Api.Modules.Billing;

namespace Fluxo.Api.Tests;

[Collection("GateBilSerial")]
public sealed class GateBil009AdminTests
{
    private static DebateApiFactory Api(GatePsp? psp = null) => GateCheckout.Api(psp ?? new GatePsp());

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Read_routes_answer_403_without_billing_read_and_200_with_it()
    {
        await using var factory = Api();
        var ledger = await GateAdmin.SeedAsync(factory);
        using var outsider = GateAdmin.Client(factory, "reports.read");
        using var reader = GateAdmin.Client(factory, "billing.read");
        foreach (var route in GateAdmin.ReadRoutes(ledger))
        {
            using (var denied = await outsider.GetAsync(route))
            {
                Assert.True(denied.StatusCode == HttpStatusCode.Forbidden, $"{route}: {(int)denied.StatusCode}");
                Assert.Equal("admin_access_denied", await DebateApiFactory.CodeAsync(denied));
            }
            using var allowed = await reader.GetAsync(route);
            Assert.True(allowed.StatusCode == HttpStatusCode.OK, $"{route}: {(int)allowed.StatusCode}");
        }
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Write_routes_demand_their_own_permission_and_recent_login()
    {
        await using var factory = Api();
        var ledger = await GateAdmin.SeedAsync(factory, chargeStatus: "paid");
        var body = new { reason = GateAdmin.Reason, evidence = "Comprovante conferido" };
        string[] manage = [$"/invoices/{ledger.Invoice}/mark-paid", $"/invoices/{ledger.Invoice}/void", $"/webhooks/{ledger.QuarantinedEvent}/replay"];
        var refund = $"/charges/{ledger.Charge}/refund";
        using var reader = GateAdmin.Client(factory, "billing.read");
        using var manager = GateAdmin.Client(factory, "billing.manage");
        using var refunder = GateAdmin.Client(factory, "billing.refund");
        using var stale = GateAdmin.Client(factory, "admin", 7200, "billing.manage", "billing.refund");
        foreach (var route in manage.Append(refund))
        {
            using var denied = await GateAdmin.PostAsync(reader, route, body);
            Assert.True(denied.StatusCode == HttpStatusCode.Forbidden, $"read em {route}: {(int)denied.StatusCode}");
            using var old = await GateAdmin.PostAsync(stale, route, body);
            Assert.True(old.StatusCode == HttpStatusCode.Unauthorized, $"login antigo em {route}: {(int)old.StatusCode}");
            Assert.Equal("reauth_required", await DebateApiFactory.CodeAsync(old));
        }
        foreach (var route in manage)
        {
            using var denied = await GateAdmin.PostAsync(refunder, route, body);
            Assert.True(denied.StatusCode == HttpStatusCode.Forbidden, $"refund em {route}: {(int)denied.StatusCode}");
        }
        using var noRefund = await GateAdmin.PostAsync(manager, refund, body);
        Assert.Equal(HttpStatusCode.Forbidden, noRefund.StatusCode);
        Assert.Equal(0L, await GateAdmin.AuditAsync(ledger));
    }

    [Theory, Trait("Category", "PostgresIntegration")]
    [InlineData(5)]
    [InlineData(501)]
    public async Task Reason_outside_10_to_500_is_refused_without_audit(int length)
    {
        await using var factory = Api();
        var ledger = await GateAdmin.SeedAsync(factory);
        using var client = GateAdmin.Client(factory, "billing.manage");
        using var response = await GateAdmin.PostAsync(client, $"/webhooks/{ledger.QuarantinedEvent}/replay", new { reason = new string('m', length) });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        Assert.Equal(0L, await GateAdmin.AuditAsync(ledger));
    }

    [Theory, Trait("Category", "PostgresIntegration")]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("LONGA")]
    public async Task Mark_paid_demands_evidence_up_to_500_characters(string? evidence)
    {
        await using var factory = Api();
        var ledger = await GateAdmin.SeedAsync(factory);
        using var client = GateAdmin.Client(factory, "billing.manage");
        using var response = await GateAdmin.PostAsync(client, $"/invoices/{ledger.Invoice}/mark-paid",
            new { reason = GateAdmin.Reason, evidence = evidence == "LONGA" ? new string('e', 501) : evidence });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        Assert.Equal("open", await GateCheckout.InvoiceStatus(ledger.Invoice));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Mark_paid_closes_the_invoice_activates_and_audits_as_manual()
    {
        await using var factory = Api();
        var ledger = await GateAdmin.SeedAsync(factory);
        using var client = GateAdmin.Client(factory, "billing.manage");
        using var response = await GateAdmin.PostAsync(client, $"/invoices/{ledger.Invoice}/mark-paid", new { reason = GateAdmin.Reason, evidence = "Comprovante conferido" });
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        Assert.Equal("paid", await GateCheckout.InvoiceStatus(ledger.Invoice));
        Assert.Equal("active", await GateCheckout.SubscriptionStatus(ledger.Subscription));
        Assert.Equal("pending", await GateCheckout.Text($"SELECT status FROM fluxo.billing_charges WHERE id='{ledger.Charge}'"));
        Assert.Equal(1L, await GateAdmin.AuditAsync(ledger, "manual"));
        Assert.Equal(1L, await GateAdmin.AuditAsync(ledger, "Comprovante conferido"));
        Assert.False(string.IsNullOrEmpty(await GateCheckout.Text($"SELECT correlation_id FROM fluxo.billing_audit_events WHERE subject_id='{ledger.BusinessId}' AND action <> 'customer.updated'")), "auditoria sem correlation_id");
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Void_closes_the_invoice_with_audit()
    {
        await using var factory = Api();
        var ledger = await GateAdmin.SeedAsync(factory);
        using var client = GateAdmin.Client(factory, "billing.manage");
        using var response = await GateAdmin.PostAsync(client, $"/invoices/{ledger.Invoice}/void", new { reason = GateAdmin.Reason });
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        Assert.Equal("void", await GateCheckout.InvoiceStatus(ledger.Invoice));
        Assert.Equal(1L, await GateAdmin.AuditAsync(ledger));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Refund_refuses_an_unpaid_charge_and_marks_a_paid_one()
    {
        await using var factory = Api();
        var unpaid = await GateAdmin.SeedAsync(factory);
        var paid = await GateAdmin.SeedAsync(factory, "paid", "paid", "active");
        using var client = GateAdmin.Client(factory, "billing.refund");
        using (var refused = await GateAdmin.PostAsync(client, $"/charges/{unpaid.Charge}/refund", new { reason = GateAdmin.Reason }))
            Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
        Assert.Equal(0L, await GateAdmin.AuditAsync(unpaid));
        using var response = await GateAdmin.PostAsync(client, $"/charges/{paid.Charge}/refund", new { reason = GateAdmin.Reason });
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        Assert.Equal("refund_pending", await GateCheckout.Text($"SELECT status FROM fluxo.billing_charges WHERE id='{paid.Charge}'"));
        Assert.Equal(1L, await GateAdmin.AuditAsync(paid));
    }

    [Theory, Trait("Category", "PostgresIntegration")]
    [InlineData("pending", true)]
    [InlineData("quarantined", true)]
    [InlineData("parse_failed", true)]
    [InlineData("processed", false)]
    [InlineData("ignored", false)]
    public async Task Replay_accepts_only_the_recoverable_statuses(string status, bool accepted)
    {
        await using var factory = Api();
        var ledger = await GateAdmin.SeedAsync(factory);
        await DebateTestDb.ExecAsync(GateBil.C, $"UPDATE fluxo.billing_webhook_events SET status='{status}', attempts=7 WHERE id='{ledger.QuarantinedEvent}'");
        using var client = GateAdmin.Client(factory, "billing.manage");
        using var response = await GateAdmin.PostAsync(client, $"/webhooks/{ledger.QuarantinedEvent}/replay", new { reason = GateAdmin.Reason });
        var row = $"FROM fluxo.billing_webhook_events WHERE id='{ledger.QuarantinedEvent}'";
        if (accepted)
        {
            Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
            Assert.Equal("pending", await GateCheckout.Text($"SELECT status {row}"));
            Assert.Equal("0", await GateCheckout.Text($"SELECT attempts::text {row}"));
            Assert.Equal(1L, await GateAdmin.AuditAsync(ledger));
        }
        else
        {
            Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
            Assert.Equal(status, await GateCheckout.Text($"SELECT status {row}"));
        }
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Cursor_walks_every_row_once_even_if_a_new_row_arrives()
    {
        await using var factory = Api();
        var ledger = await GateAdmin.SeedAsync(factory);
        var product = "b1000000-0000-4000-8000-000000000002";
        var extra = Enumerable.Range(0, 4).Select(i =>
            $"('{Guid.NewGuid()}','{ledger.Customer}','{product}','canceled','pix_manual',1,false,now()-interval '{i + 1} minutes',now(),0)");
        await DebateTestDb.ExecAsync(GateBil.C,
            $"INSERT INTO fluxo.billing_subscriptions(id,customer_id,product_id,status,rail,quantity,cancel_at_period_end,created_at,updated_at,version) VALUES {string.Join(',', extra)}");
        using var client = GateAdmin.Client(factory, "billing.read");
        var seen = new List<string>();
        string? cursor = null;
        for (var page = 0; page < 6; page++)
        {
            var query = $"{GateAdmin.Base}/subscriptions?search={ledger.BusinessId}&limit=2{(cursor is null ? "" : $"&cursor={Uri.EscapeDataString(cursor)}")}";
            using var response = await client.GetAsync(query);
            var body = await GateBil.JsonAsync(response);
            var items = body.GetProperty("items").EnumerateArray().ToArray();
            Assert.InRange(items.Length, 0, 2);
            seen.AddRange(items.Select(x => x.GetProperty("id").GetString()!));
            cursor = body.TryGetProperty("nextCursor", out var next) && next.ValueKind == System.Text.Json.JsonValueKind.String ? next.GetString() : null;
            if (cursor is null) break;
            if (page == 0) await DebateTestDb.ExecAsync(GateBil.C,
                $"INSERT INTO fluxo.billing_subscriptions(id,customer_id,product_id,status,rail,quantity,cancel_at_period_end,created_at,updated_at,version) VALUES ('{Guid.NewGuid()}','{ledger.Customer}','{product}','canceled','pix_manual',1,false,now(),now(),0)");
        }
        Assert.Null(cursor);
        Assert.Equal(seen.Count, seen.Distinct().Count());
        Assert.Equal(5, seen.Count);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Search_finds_by_business_external_id_and_document_hmac()
    {
        await using var factory = Api();
        var ledger = await GateAdmin.SeedAsync(factory);
        using var client = GateAdmin.Client(factory, "billing.read");
        foreach (var search in new[] { ledger.BusinessId, GateAdmin.RawTaxId })
        {
            using var response = await client.GetAsync($"{GateAdmin.Base}/subscriptions?search={Uri.EscapeDataString(search)}&limit=100");
            var ids = (await GateBil.JsonAsync(response)).GetProperty("items").EnumerateArray().Select(x => x.GetProperty("id").GetString());
            Assert.Contains(ledger.Subscription.ToString(), ids);
        }
        using var filtered = await client.GetAsync($"{GateAdmin.Base}/subscriptions?search={ledger.BusinessId}&status=active");
        Assert.Empty((await GateBil.JsonAsync(filtered)).GetProperty("items").EnumerateArray());
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Reconcile_records_its_run_and_health_shows_it()
    {
        await GateCheckout.QuietAsync();
        await using var factory = Api();
        var before = await DebateTestDb.ScalarAsync<long>(GateBil.C, "SELECT count(*) FROM fluxo.billing_audit_events WHERE action='job.reconcile'");
        Assert.True(await BillingJobs.TryRunAsync([GateCheckout.Job], factory.Services));
        Assert.Equal(before + 1, await DebateTestDb.ScalarAsync<long>(GateBil.C, "SELECT count(*) FROM fluxo.billing_audit_events WHERE action='job.reconcile'"));
        using var client = GateAdmin.Client(factory, "billing.read");
        using var response = await client.GetAsync($"{GateAdmin.Base}/health");
        var body = await GateBil.JsonAsync(response);
        var names = body.EnumerateObject().ToDictionary(p => p.Name.ToLowerInvariant(), p => p.Value);
        var reconcile = names.Where(p => p.Key.Contains("reconcile")).Select(p => p.Value).ToArray();
        Assert.NotEmpty(reconcile);
        Assert.Contains(reconcile, v => v.ValueKind == System.Text.Json.JsonValueKind.String);
        Assert.Contains(names, p => p.Key.Contains("auth"));
        Assert.Contains(names, p => p.Key.Contains("received") || p.Key.Contains("lastevent"));
        Assert.Contains(names, p => p.Key.Contains("webhook") && p.Value.ValueKind is System.Text.Json.JsonValueKind.Object or System.Text.Json.JsonValueKind.Array);
    }
}
