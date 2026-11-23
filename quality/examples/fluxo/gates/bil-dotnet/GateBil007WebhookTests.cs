// Gate BIL-007-WEBHOOK-NAO-LIBERA-SOZINHO. Template do autor de gates. O webhook é só um aviso: o que vale é a consulta ao PSP.
using Fluxo.Api.Modules.Billing;
using Fluxo.Api.Modules.Billing.Domain;
using Fluxo.Api.Modules.Billing.Gateways;

namespace Fluxo.Api.Tests;

[Collection("GateBilSerial")]
public sealed class GateBil007WebhookTests
{
    private static async Task AssertUntouched(GateCheckoutState state)
    {
        Assert.Equal("open", await GateCheckout.InvoiceStatus(state.InvoiceId));
        Assert.Equal("incomplete", await GateCheckout.SubscriptionStatus(state.SubscriptionId));
        Assert.Equal("pending", await GateCheckout.ChargeStatus(state.ExternalChargeId));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Paid_at_the_psp_activates_the_plan_for_one_month_with_audit()
    {
        var psp = new GatePsp();
        await using var factory = GateCheckout.Api(psp);
        var state = await GateCheckout.OpenAsync(factory, psp);
        psp.MarkPaid(state.ExternalChargeId);
        using var client = factory.CreateClient();
        var id = $"evt_{Guid.NewGuid():N}";
        await GateCheckout.WebhookAsync(client, state.ExternalChargeId, id: id);
        Assert.Equal("paid", await GateCheckout.ChargeStatus(state.ExternalChargeId));
        Assert.Equal("paid", await GateCheckout.InvoiceStatus(state.InvoiceId));
        Assert.Equal("active", await GateCheckout.SubscriptionStatus(state.SubscriptionId));
        Assert.Equal("processed", await GateCheckout.EventStatus(id));
        var days = await DebateTestDb.ScalarAsync<double>(GateBil.C,
            $"SELECT (extract(epoch FROM current_period_end - current_period_start)/86400)::float8 FROM fluxo.billing_subscriptions WHERE id='{state.SubscriptionId}'");
        Assert.InRange(days, 28, 31);
        Assert.True(await GateCheckout.AuditCountAsync(state.BusinessId) >= 1, "ativação sem auditoria");
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Yearly_price_gets_one_year()
    {
        var psp = new GatePsp();
        await using var factory = GateCheckout.Api(psp);
        var state = await GateCheckout.OpenAsync(factory, psp, await GateCheckout.SeedPriceAsync(interval: "year"));
        psp.MarkPaid(state.ExternalChargeId);
        using var client = factory.CreateClient();
        await GateCheckout.WebhookAsync(client, state.ExternalChargeId);
        var days = await DebateTestDb.ScalarAsync<double>(GateBil.C,
            $"SELECT (extract(epoch FROM current_period_end - current_period_start)/86400)::float8 FROM fluxo.billing_subscriptions WHERE id='{state.SubscriptionId}'");
        Assert.InRange(days, 365, 366);
    }

    [Theory, Trait("Category", "PostgresIntegration")]
    [InlineData("amount")]
    [InlineData("currency")]
    [InlineData("reference")]
    [InlineData("customer")]
    public async Task Divergence_from_the_local_charge_quarantines_without_transition(string field)
    {
        var psp = new GatePsp();
        await using var factory = GateCheckout.Api(psp);
        var state = await GateCheckout.OpenAsync(factory, psp);
        psp.MarkPaid(state.ExternalChargeId);
        psp.Set(state.ExternalChargeId, c => field switch
        {
            "amount" => c with { AmountCents = c.AmountCents - 1 },
            "currency" => c with { Currency = "USD" },
            "reference" => c with { ExternalReference = Guid.NewGuid().ToString() },
            _ => c with { ExternalCustomerId = "cus_outro" },
        });
        using var client = factory.CreateClient();
        var id = $"evt_{Guid.NewGuid():N}";
        await GateCheckout.WebhookAsync(client, state.ExternalChargeId, id: id);
        Assert.Equal("quarantined", await GateCheckout.EventStatus(id));
        await AssertUntouched(state);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Event_saying_received_does_not_count_while_the_psp_says_pending()
    {
        var psp = new GatePsp();
        await using var factory = GateCheckout.Api(psp);
        var state = await GateCheckout.OpenAsync(factory, psp);
        using var client = factory.CreateClient();
        await GateCheckout.WebhookAsync(client, state.ExternalChargeId);
        Assert.True(psp.Gets >= 1, "o processador precisa consultar o PSP");
        await AssertUntouched(state);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Forged_event_with_a_valid_token_and_unknown_id_is_ignored()
    {
        var psp = new GatePsp();
        await using var factory = GateCheckout.Api(psp);
        var state = await GateCheckout.OpenAsync(factory, psp);
        using var client = factory.CreateClient();
        var id = $"evt_{Guid.NewGuid():N}";
        await GateCheckout.WebhookAsync(client, $"pay_forjado_{Guid.NewGuid():N}", id: id);
        Assert.Equal("ignored", await GateCheckout.EventStatus(id));
        await AssertUntouched(state);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Psp_down_answers_200_stays_pending_and_the_job_applies_it()
    {
        await GateCheckout.QuietAsync();
        var psp = new GatePsp();
        await using var factory = GateCheckout.Api(psp);
        var state = await GateCheckout.OpenAsync(factory, psp);
        psp.MarkPaid(state.ExternalChargeId);
        psp.Down = true;
        using var client = factory.CreateClient();
        var id = $"evt_{Guid.NewGuid():N}";
        await GateCheckout.WebhookAsync(client, state.ExternalChargeId, id: id);
        Assert.Equal("pending", await GateCheckout.EventStatus(id));
        await AssertUntouched(state);

        psp.Down = false;
        Assert.True(await BillingJobs.TryRunAsync([GateCheckout.Job], factory.Services));
        Assert.Equal("processed", await GateCheckout.EventStatus(id));
        Assert.Equal("active", await GateCheckout.SubscriptionStatus(state.SubscriptionId));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Repeated_and_out_of_order_events_make_one_transition()
    {
        var psp = new GatePsp();
        await using var factory = GateCheckout.Api(psp);
        var state = await GateCheckout.OpenAsync(factory, psp);
        psp.MarkPaid(state.ExternalChargeId);
        using var client = factory.CreateClient();
        await GateCheckout.WebhookAsync(client, state.ExternalChargeId, "PAYMENT_CONFIRMED");
        var audit = await GateCheckout.AuditCountAsync(state.BusinessId);
        var period = await GateCheckout.Text($"SELECT current_period_end::text FROM fluxo.billing_subscriptions WHERE id='{state.SubscriptionId}'");
        var (late, repeat) = ($"evt_{Guid.NewGuid():N}", $"evt_{Guid.NewGuid():N}");
        await GateCheckout.WebhookAsync(client, state.ExternalChargeId, "PAYMENT_CREATED", late);
        await GateCheckout.WebhookAsync(client, state.ExternalChargeId, "PAYMENT_RECEIVED", repeat);
        Assert.Equal("processed", await GateCheckout.EventStatus(late));
        Assert.Equal("processed", await GateCheckout.EventStatus(repeat));
        Assert.Equal(audit, await GateCheckout.AuditCountAsync(state.BusinessId));
        Assert.Equal(period, await GateCheckout.Text($"SELECT current_period_end::text FROM fluxo.billing_subscriptions WHERE id='{state.SubscriptionId}'"));
        Assert.Equal(1L, await DebateTestDb.ScalarAsync<long>(GateBil.C, $"SELECT version FROM fluxo.billing_subscriptions WHERE id='{state.SubscriptionId}'"));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Status_follows_the_psp_and_not_the_event_type()
    {
        var psp = new GatePsp();
        await using var factory = GateCheckout.Api(psp);
        var state = await GateCheckout.OpenAsync(factory, psp);
        using var client = factory.CreateClient();
        psp.Set(state.ExternalChargeId, c => c with { Status = BillingChargeStatus.Expired });
        await GateCheckout.WebhookAsync(client, state.ExternalChargeId, "PAYMENT_RECEIVED");
        Assert.Equal("expired", await GateCheckout.ChargeStatus(state.ExternalChargeId));
        Assert.Equal("open", await GateCheckout.InvoiceStatus(state.InvoiceId));

        // Vencida que o PSP mostra paga vira paga, mesmo com evento de vencimento.
        psp.MarkPaid(state.ExternalChargeId);
        await GateCheckout.WebhookAsync(client, state.ExternalChargeId, "PAYMENT_OVERDUE");
        Assert.Equal("paid", await GateCheckout.ChargeStatus(state.ExternalChargeId));
        Assert.Equal("active", await GateCheckout.SubscriptionStatus(state.SubscriptionId));

        psp.Set(state.ExternalChargeId, c => c with { Status = BillingChargeStatus.Refunded });
        await GateCheckout.WebhookAsync(client, state.ExternalChargeId, "PAYMENT_UPDATED");
        Assert.Equal("refunded", await GateCheckout.ChargeStatus(state.ExternalChargeId));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Late_payment_on_a_canceled_subscription_does_not_reactivate()
    {
        var psp = new GatePsp();
        await using var factory = GateCheckout.Api(psp);
        var state = await GateCheckout.OpenAsync(factory, psp);
        await DebateTestDb.ExecAsync(GateBil.C, $"UPDATE fluxo.billing_subscriptions SET status='canceled', canceled_at=now() WHERE id='{state.SubscriptionId}'");
        psp.MarkPaid(state.ExternalChargeId);
        using var client = factory.CreateClient();
        var id = $"evt_{Guid.NewGuid():N}";
        await GateCheckout.WebhookAsync(client, state.ExternalChargeId, id: id);
        Assert.Equal("paid", await GateCheckout.ChargeStatus(state.ExternalChargeId));
        Assert.Equal("quarantined", await GateCheckout.EventStatus(id));
        Assert.Equal("canceled", await GateCheckout.SubscriptionStatus(state.SubscriptionId));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task The_whole_paid_flow_creates_no_outbox_message()
    {
        var psp = new GatePsp();
        await using var factory = GateCheckout.Api(psp);
        var state = await GateCheckout.OpenAsync(factory, psp);
        var count = () => DebateTestDb.ScalarAsync<long>(GateBil.C,
            $"SELECT count(*) FROM fluxo.outbox_messages m WHERE to_jsonb(m)::text ILIKE '%billing%' OR to_jsonb(m)::text LIKE '%{state.BusinessId}%' OR to_jsonb(m)::text LIKE '%{state.SubscriptionId}%'");
        var before = await count();
        psp.MarkPaid(state.ExternalChargeId);
        using var client = factory.CreateClient();
        await GateCheckout.WebhookAsync(client, state.ExternalChargeId);
        Assert.Equal("paid", await GateCheckout.InvoiceStatus(state.InvoiceId));
        Assert.Equal(before, await count());
        Assert.Equal(0L, before);
    }
}
