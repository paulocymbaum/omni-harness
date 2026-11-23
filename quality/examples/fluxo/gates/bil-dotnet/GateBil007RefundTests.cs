// Gate BIL-007-ARREPENDIMENTO. Template do autor de gates. A rota não chama o PSP: quem estorna é o job.
using System.Net;
using Fluxo.Api.Modules.Billing;

namespace Fluxo.Api.Tests;

[Collection("GateBilSerial")]
public sealed class GateBil007RefundTests
{
    private const string Reason = "Empresa desistiu da contratação";

    private static async Task<(DebateApiFactory Factory, GatePsp Psp, GateCheckoutState State, HttpClient Client)> PaidAsync(Action<Microsoft.Extensions.DependencyInjection.IServiceCollection>? more = null)
    {
        await GateCheckout.QuietAsync();
        var psp = new GatePsp();
        var factory = GateCheckout.Api(psp, more: more);
        var state = await GateCheckout.OpenAsync(factory, psp);
        psp.MarkPaid(state.ExternalChargeId);
        using (var hook = factory.CreateClient()) await GateCheckout.WebhookAsync(hook, state.ExternalChargeId);
        Assert.Equal("active", await GateCheckout.SubscriptionStatus(state.SubscriptionId));
        return (factory, psp, state, factory.Client($"user:{state.Owner}"));
    }

    private static Task<HttpResponseMessage> CancelAsync(HttpClient client, Guid id) =>
        DebateApiFactory.SendAsync(client, HttpMethod.Post, $"/api/v1/billing/subscriptions/{id}/cancel", new { reason = Reason });

    private static Task<string?> Column(Guid id, string column) => GateCheckout.Text($"SELECT {column}::text FROM fluxo.billing_subscriptions WHERE id='{id}'");

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Within_seven_days_cancels_marks_refund_pending_and_the_job_refunds_once()
    {
        var (factory, psp, state, client) = await PaidAsync();
        await using var _f = factory;
        var audit = await GateCheckout.AuditCountAsync(state.BusinessId);
        var touches = psp.Touches;
        using (var response = await CancelAsync(client, state.SubscriptionId)) await GateBil.JsonAsync(response);
        Assert.Equal("canceled", await GateCheckout.SubscriptionStatus(state.SubscriptionId));
        Assert.Equal("refund_pending", await GateCheckout.ChargeStatus(state.ExternalChargeId));
        Assert.Equal(touches, psp.Touches);
        Assert.NotEmpty(await Column(state.SubscriptionId, "canceled_at") ?? "");
        Assert.Equal(Reason, await Column(state.SubscriptionId, "cancel_reason"));
        Assert.Equal(audit + 1, await GateCheckout.AuditCountAsync(state.BusinessId));

        await BillingJobs.TryRunAsync([GateCheckout.Job], factory.Services);
        await BillingJobs.TryRunAsync([GateCheckout.Job], factory.Services);
        Assert.Equal(1, psp.Refunds);
        Assert.Equal("refunded", await GateCheckout.ChargeStatus(state.ExternalChargeId));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task After_seven_days_keeps_access_to_the_end_of_the_period_without_refund()
    {
        var (factory, psp, state, client) = await PaidAsync();
        await using var _f = factory;
        await DebateTestDb.ExecAsync(GateBil.C, $"""
            UPDATE fluxo.billing_charges SET paid_at = now() - interval '8 days' WHERE external_charge_id='{state.ExternalChargeId}';
            UPDATE fluxo.billing_subscriptions SET current_period_start = now() - interval '8 days' WHERE id='{state.SubscriptionId}';
            """);
        var audit = await GateCheckout.AuditCountAsync(state.BusinessId);
        using (var response = await CancelAsync(client, state.SubscriptionId)) await GateBil.JsonAsync(response);
        Assert.Equal("pending_cancellation", await GateCheckout.SubscriptionStatus(state.SubscriptionId));
        Assert.Equal("paid", await GateCheckout.ChargeStatus(state.ExternalChargeId));
        Assert.NotEmpty(await Column(state.SubscriptionId, "canceled_at") ?? "");
        Assert.Equal(Reason, await Column(state.SubscriptionId, "cancel_reason"));
        Assert.Equal(audit + 1, await GateCheckout.AuditCountAsync(state.BusinessId));
        await BillingJobs.TryRunAsync([GateCheckout.Job], factory.Services);
        Assert.Equal(0, psp.Refunds);
        using var plan = await client.GetAsync($"/api/v1/billing/subjects/business/{state.BusinessId}/entitlements");
        Assert.Equal("subscription", (await GateBil.JsonAsync(plan)).GetProperty("source").GetString());
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Another_person_cannot_cancel()
    {
        // Quem não é dono cai no fallback do Firestore: exige o emulador.
        var (factory, _, state, _) = await PaidAsync(GateBil.LegacyDirectoryOnEmulator());
        await using var _f = factory;
        using var stranger = factory.Client($"user:estranho-{Guid.NewGuid():N}");
        using var response = await CancelAsync(stranger, state.SubscriptionId);
        Assert.InRange((int)response.StatusCode, 403, 404);
        Assert.Equal("active", await GateCheckout.SubscriptionStatus(state.SubscriptionId));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Cancel_route_stays_under_the_middleware()
    {
        var (factory, _, state, client) = await PaidAsync();
        await using var _f = factory;
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/billing/subscriptions/{state.SubscriptionId}/cancel") { Content = System.Net.Http.Json.JsonContent.Create(new { reason = Reason }) };
        using var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("idempotency_key_required", await DebateApiFactory.CodeAsync(response));
        Assert.Equal("active", await GateCheckout.SubscriptionStatus(state.SubscriptionId));
    }
}
