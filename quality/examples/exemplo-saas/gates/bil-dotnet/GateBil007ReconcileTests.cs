// Gate BIL-007-RECONCILE. Template do autor de gates. Roda o job pela mesma entrada do processo, BillingJobs.TryRunAsync. Idades são
// forçadas por SQL. Serial: o job percorre a tabela inteira e pega advisory lock.
using System.Diagnostics;
using System.Net;
using Fluxo.Api.Modules.Billing;
using Fluxo.Api.Modules.Billing.Domain;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Fluxo.Api.Tests;

[Collection("GateBilSerial")]
public sealed class GateBil007ReconcileTests
{
    private static async Task<(DebateApiFactory Factory, GatePsp Psp, GateCheckoutState State)> OpenAsync()
    {
        await GateCheckout.QuietAsync();
        var psp = new GatePsp();
        var factory = GateCheckout.Api(psp);
        return (factory, psp, await GateCheckout.OpenAsync(factory, psp));
    }

    private static async Task RunAsync(DebateApiFactory factory) => Assert.True(await BillingJobs.TryRunAsync([GateCheckout.Job], factory.Services));
    private static Task Age(GateCheckoutState state, string interval) => DebateTestDb.ExecAsync(GateBil.C,
        $"UPDATE fluxo.billing_charges SET created_at = now() - interval '{interval}' WHERE external_charge_id='{state.ExternalChargeId}'");

    private static async Task<(string Id, string Status)> EventAsync(DebateApiFactory factory, GatePsp psp, GateCheckoutState state)
    {
        psp.Down = true;
        using var client = factory.CreateClient();
        var id = $"evt_{Guid.NewGuid():N}";
        await GateCheckout.WebhookAsync(client, state.ExternalChargeId, id: id);
        psp.Down = false;
        return (id, (await GateCheckout.EventStatus(id))!);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Old_received_events_are_recovered()
    {
        var (factory, psp, state) = await OpenAsync();
        await using var _f = factory;
        var (id, _) = await EventAsync(factory, psp, state);
        psp.MarkPaid(state.ExternalChargeId);
        await DebateTestDb.ExecAsync(GateBil.C, $"UPDATE fluxo.billing_webhook_events SET status='received', attempts=0, received_at=now()-interval '2 hours' WHERE provider_event_id='{id}'");
        await RunAsync(factory);
        Assert.Equal("processed", await GateCheckout.EventStatus(id));
        Assert.Equal("active", await GateCheckout.SubscriptionStatus(state.SubscriptionId));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Pending_event_with_ten_attempts_is_left_alone()
    {
        var (factory, psp, state) = await OpenAsync();
        await using var _f = factory;
        var (id, _) = await EventAsync(factory, psp, state);
        await DebateTestDb.ExecAsync(GateBil.C, $"UPDATE fluxo.billing_webhook_events SET attempts=10 WHERE provider_event_id='{id}'");
        psp.MarkPaid(state.ExternalChargeId);
        await RunAsync(factory);
        Assert.Equal("pending", await GateCheckout.EventStatus(id));
        Assert.Equal("10", await GateCheckout.Text($"SELECT attempts::text FROM fluxo.billing_webhook_events WHERE provider_event_id='{id}'"));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Pending_charge_past_five_minutes_is_read_from_the_psp_and_a_recent_one_is_not()
    {
        var (factory, psp, state) = await OpenAsync();
        await using var _f = factory;
        psp.MarkPaid(state.ExternalChargeId);
        await RunAsync(factory);
        Assert.Equal(0, psp.Gets);
        Assert.Equal("pending", await GateCheckout.ChargeStatus(state.ExternalChargeId));
        await Age(state, "6 minutes");
        await RunAsync(factory);
        Assert.Equal("paid", await GateCheckout.ChargeStatus(state.ExternalChargeId));
        Assert.Equal("active", await GateCheckout.SubscriptionStatus(state.SubscriptionId));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Overdue_qr_expires_unless_the_psp_shows_it_paid()
    {
        var (factory, psp, state) = await OpenAsync();
        await using var _f = factory;
        await Age(state, "1 hour");
        var expire = $"UPDATE fluxo.billing_charges SET qr_expires_at = now() - interval '1 minute' WHERE external_charge_id='{state.ExternalChargeId}'";
        await DebateTestDb.ExecAsync(GateBil.C, expire);
        await RunAsync(factory);
        Assert.Equal("expired", await GateCheckout.ChargeStatus(state.ExternalChargeId));

        var second = await GateCheckout.OpenAsync(factory, psp);
        await DebateTestDb.ExecAsync(GateBil.C, $"UPDATE fluxo.billing_charges SET created_at=now()-interval '1 hour', qr_expires_at=now()-interval '1 minute' WHERE external_charge_id='{second.ExternalChargeId}'");
        psp.MarkPaid(second.ExternalChargeId);
        await RunAsync(factory);
        Assert.Equal("paid", await GateCheckout.ChargeStatus(second.ExternalChargeId));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Incomplete_past_24_hours_expires_and_voids_the_invoice()
    {
        var (factory, _, state) = await OpenAsync();
        await using var _f = factory;
        await RunAsync(factory);
        Assert.Equal("incomplete", await GateCheckout.SubscriptionStatus(state.SubscriptionId));
        await DebateTestDb.ExecAsync(GateBil.C, $"UPDATE fluxo.billing_subscriptions SET created_at=now()-interval '25 hours' WHERE id='{state.SubscriptionId}'");
        await RunAsync(factory);
        Assert.Equal("incomplete_expired", await GateCheckout.SubscriptionStatus(state.SubscriptionId));
        Assert.Equal("void", await GateCheckout.InvoiceStatus(state.InvoiceId));
    }

    private static async Task<(string Id, Guid Subscription, string Owner)> ManualPlanAsync(DebateApiFactory factory, DateTimeOffset? endsAt)
    {
        await GateBil.ApplyMvpAsync();
        var (id, owner) = await GateBil.SeedBusinessAsync();
        var uid = $"admin-{Guid.NewGuid():N}";
        factory.Registry.Grant(uid, "admin", "billing.manage");
        using var admin = factory.Client(DebateApiFactory.Admin(uid));
        using var created = await DebateApiFactory.SendAsync(admin, HttpMethod.Post, $"/api/v1/admin/billing/subjects/business/{id}/manual-plan",
            new { productCode = "local", reason = "Cortesia do piloto com a empresa", endsAt });
        var body = await GateBil.JsonAsync(created);
        return (id, body.GetProperty("id").GetGuid(), owner);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Manual_plan_past_its_end_date_is_closed_with_audit()
    {
        await GateCheckout.QuietAsync();
        var psp = new GatePsp();
        await using var factory = GateCheckout.Api(psp);
        var due = await ManualPlanAsync(factory, DateTimeOffset.UtcNow.AddDays(10));
        var future = await ManualPlanAsync(factory, DateTimeOffset.UtcNow.AddDays(10));
        var open = await ManualPlanAsync(factory, null);
        await DebateTestDb.ExecAsync(GateBil.C, $"UPDATE fluxo.billing_subscriptions SET current_period_end=now()-interval '1 minute' WHERE id='{due.Subscription}'");
        var audit = await GateCheckout.AuditCountAsync(due.Id);
        await RunAsync(factory);
        Assert.Equal("canceled", await GateCheckout.SubscriptionStatus(due.Subscription));
        Assert.Equal(audit + 1, await GateCheckout.AuditCountAsync(due.Id));
        Assert.Equal("active", await GateCheckout.SubscriptionStatus(future.Subscription));
        Assert.Equal("active", await GateCheckout.SubscriptionStatus(open.Subscription));
        using var owner = factory.Client($"user:{due.Owner}");
        using var plan = await owner.GetAsync($"/api/v1/billing/subjects/business/{due.Id}/entitlements");
        Assert.Equal("presenca", (await GateBil.JsonAsync(plan)).GetProperty("planCode").GetString());
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Pending_cancellation_closes_only_at_the_end_of_the_period()
    {
        var (factory, psp, state) = await OpenAsync();
        await using var _f = factory;
        psp.MarkPaid(state.ExternalChargeId);
        using var client = factory.CreateClient();
        await GateCheckout.WebhookAsync(client, state.ExternalChargeId);
        await DebateTestDb.ExecAsync(GateBil.C, $"UPDATE fluxo.billing_subscriptions SET status='pending_cancellation' WHERE id='{state.SubscriptionId}'");
        await RunAsync(factory);
        Assert.Equal("pending_cancellation", await GateCheckout.SubscriptionStatus(state.SubscriptionId));
        await DebateTestDb.ExecAsync(GateBil.C, $"UPDATE fluxo.billing_subscriptions SET current_period_end=now()-interval '1 minute' WHERE id='{state.SubscriptionId}'");
        var audit = await GateCheckout.AuditCountAsync(state.BusinessId);
        await RunAsync(factory);
        Assert.Equal("canceled", await GateCheckout.SubscriptionStatus(state.SubscriptionId));
        Assert.Equal(audit + 1, await GateCheckout.AuditCountAsync(state.BusinessId));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Raw_body_older_than_180_days_is_erased_and_a_newer_one_is_kept()
    {
        var (factory, psp, state) = await OpenAsync();
        await using var _f = factory;
        var (old, _) = await EventAsync(factory, psp, state);
        var (recent, _) = await EventAsync(factory, psp, state);
        await DebateTestDb.ExecAsync(GateBil.C, $"""
            UPDATE fluxo.billing_webhook_events SET status='processed', received_at=now()-interval '181 days' WHERE provider_event_id='{old}';
            UPDATE fluxo.billing_webhook_events SET status='processed', received_at=now()-interval '179 days' WHERE provider_event_id='{recent}';
            """);
        await RunAsync(factory);
        var body = (string id) => GateCheckout.Text($"SELECT coalesce(raw_body,'') FROM fluxo.billing_webhook_events WHERE provider_event_id='{id}'");
        Assert.DoesNotContain(state.ExternalChargeId, await body(old));
        Assert.Contains(state.ExternalChargeId, await body(recent));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Two_jobs_at_once_refund_once()
    {
        var (factory, psp, state) = await OpenAsync();
        await using var _f = factory;
        psp.MarkPaid(state.ExternalChargeId);
        using var client = factory.CreateClient();
        await GateCheckout.WebhookAsync(client, state.ExternalChargeId);
        await DebateTestDb.ExecAsync(GateBil.C, $"UPDATE fluxo.billing_charges SET status='refund_pending' WHERE external_charge_id='{state.ExternalChargeId}'");
        psp.RefundDelay = TimeSpan.FromMilliseconds(500);
        await Task.WhenAll(RunAsync(factory), RunAsync(factory));
        await RunAsync(factory);
        Assert.Equal(1, psp.Refunds);
        Assert.Equal("refunded", await GateCheckout.ChargeStatus(state.ExternalChargeId));
    }

    private static DebateApiFactory AsaasApi(GateAsaasHttp http, GateLogs? logs = null) => new(GateBil.C, s =>
    {
        GateAsaasHttp.Install(http)(s);
        if (logs is not null) s.AddSingleton<ILoggerProvider>(logs);
    }, GateCheckout.Settings(("Billing:Provider", "asaas"), ("Asaas:BaseUrl", "https://asaas.gate.invalid/v3"), ("Asaas:ApiKey", "gate-api-key-nao-real")));

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Expired_key_is_logged_as_billing_psp_auth_failed_and_keeps_the_event()
    {
        var (factory, psp, state) = await OpenAsync();
        await using var _f = factory;
        var (id, _) = await EventAsync(factory, psp, state);
        var (http, logs) = (new GateAsaasHttp(), new GateLogs());
        http.Respond = (_, _) => Task.FromResult(GateAsaasHttp.Json("""{"errors":[{"code":"ACCESS_TOKEN_EXPIRED","description":"expirou"}]}""", HttpStatusCode.Unauthorized));
        await using var asaas = AsaasApi(http, logs);
        await RunAsync(asaas);
        Assert.Contains("billing_psp_auth_failed", logs.All);
        Assert.DoesNotContain("gate-api-key-nao-real", logs.All);
        Assert.Equal("pending", await GateCheckout.EventStatus(id));
    }

    // Processador recebe CancellationToken.None: sem tempo limite no gateway, este job nunca terminaria.
    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Hanging_psp_does_not_hold_the_job()
    {
        var (factory, psp, state) = await OpenAsync();
        await using var _f = factory;
        var (id, _) = await EventAsync(factory, psp, state);
        var http = new GateAsaasHttp { Respond = async (_, ct) => { await Task.Delay(Timeout.Infinite, ct); return GateAsaasHttp.Json("{}"); } };
        await using var asaas = AsaasApi(http);
        var watch = Stopwatch.StartNew();
        await RunAsync(asaas).WaitAsync(TimeSpan.FromSeconds(40));
        Assert.True(watch.Elapsed.TotalSeconds >= 6, $"o job não consultou o PSP pendurado ({watch.Elapsed.TotalSeconds:F1} s)");
        Assert.NotEmpty(http.Calls);
        Assert.Equal("pending", await GateCheckout.EventStatus(id));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task One_failure_does_not_stop_the_other_charges()
    {
        var (factory, psp, state) = await OpenAsync();
        await using var _f = factory;
        var good = await GateCheckout.OpenAsync(factory, psp);
        await Age(state, "1 hour");
        await Age(good, "1 hour");
        psp.MarkPaid(good.ExternalChargeId);
        Assert.True(psp.Charges.TryRemove(state.ExternalChargeId, out _));
        await RunAsync(factory);
        Assert.Equal("paid", await GateCheckout.ChargeStatus(good.ExternalChargeId));
    }
}
