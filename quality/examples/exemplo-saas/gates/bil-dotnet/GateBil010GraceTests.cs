// Gate BIL-010-CARENCIA-SEM-CORTE. Template do autor de gates. Inadimplência tem carência, não apaga dado e não corta recurso existente.
using System.Net;
using System.Text.Json;

namespace Fluxo.Api.Tests;

[Collection("GateBilSerial")]
public sealed class GateBil010GraceTests
{
    private static async Task<(GateFakeAsaas Fake, GateClock Clock, DebateApiFactory Factory, GateAuto State, GateFakeAsaas.Payment Renewal, DateTimeOffset Due, Guid Invoice)> OpenAsync()
    {
        await GateRecurrence.QuietAsync();
        var (fake, clock) = (new GateFakeAsaas(), new GateClock(GateRecurrence.Noon()));
        var factory = GateRecurrence.Api(fake, clock);
        var (state, renewal, due, invoice) = await GateRecurrence.RenewedAsync(factory, fake, clock);
        return (fake, clock, factory, state, renewal, due, invoice);
    }

    private static async Task<string> PlanAsync(GateAuto state)
    {
        using var response = await state.Client.GetAsync($"/api/v1/billing/subjects/business/{state.BusinessId}/entitlements");
        return (await GateBil.JsonAsync(response)).GetProperty("planCode").GetString()!;
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Day_one_late_is_past_due_with_grace_keeping_the_plan()
    {
        var (_, clock, factory, state, _, due, _) = await OpenAsync();
        await using var _f = factory;
        using var _c = state.Client;
        var plan = await PlanAsync(state);
        await GateRecurrence.PassAsync(factory, clock, due, 0);
        Assert.Equal("active", await GateCheckout.SubscriptionStatus(state.Subscription));
        await GateRecurrence.PassAsync(factory, clock, due, 1);
        Assert.Equal("past_due", await GateCheckout.SubscriptionStatus(state.Subscription));
        var grace = await GateRecurrence.Moment($"SELECT grace_until FROM fluxo.billing_subscriptions WHERE id='{state.Subscription}'");
        Assert.Equal(due.AddDays(7).UtcDateTime.Date, grace.UtcDateTime.Date);
        Assert.Equal(plan, await PlanAsync(state));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task End_of_grace_falls_to_presenca_cancels_at_the_psp_and_erases_nothing()
    {
        var (fake, clock, factory, state, renewal, due, invoice) = await OpenAsync();
        await using var _f = factory;
        using var _c = state.Client;
        for (var day = 1; day <= 7; day++) await GateRecurrence.PassAsync(factory, clock, due, day);
        Assert.Equal("past_due", await GateCheckout.SubscriptionStatus(state.Subscription));
        var invoices = await GateRecurrence.Count($"SELECT count(*) FROM fluxo.billing_invoices WHERE subscription_id='{state.Subscription}'");
        await GateRecurrence.PassAsync(factory, clock, due, 8);
        Assert.Equal("canceled", await GateCheckout.SubscriptionStatus(state.Subscription));
        Assert.Equal("presenca", await PlanAsync(state));
        Assert.True(fake.AuthorizationCanceled(state.Authorization), "autorização segue viva no PSP");
        Assert.True(renewal.Deleted, "cobrança aberta segue no PSP e poderia ser liquidada");
        Assert.Equal(invoices, await GateRecurrence.Count($"SELECT count(*) FROM fluxo.billing_invoices WHERE subscription_id='{state.Subscription}'"));
        Assert.Equal(1, await GateRecurrence.Count($"SELECT count(*) FROM fluxo.billing_charges WHERE invoice_id='{invoice}'"));
        using var business = await state.Client.GetAsync($"/api/v1/businesses/{state.BusinessId}");
        Assert.Equal(HttpStatusCode.OK, business.StatusCode);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Paying_during_the_grace_returns_to_active_keeps_the_period_start_and_stops_the_retries()
    {
        var (fake, clock, factory, state, renewal, due, invoice) = await OpenAsync();
        await using var _f = factory;
        using var _c = state.Client;
        using var hook = factory.CreateClient();
        clock.Now = due;
        fake.Instructions[renewal.Instruction!] = "REFUSED";
        await GateRecurrence.EventAsync(hook, $"{GateRecurrence.Prefix}PAYMENT_INSTRUCTION_REFUSED", "paymentInstruction", new { id = renewal.Instruction, paymentId = renewal.Id });
        for (var day = 1; day <= 3; day++) await GateRecurrence.PassAsync(factory, clock, due, day);
        Assert.Equal("past_due", await GateCheckout.SubscriptionStatus(state.Subscription));
        clock.Now = due.AddDays(4);
        fake.Pay(renewal.Id);
        await GateRecurrence.EventAsync(hook, "PAYMENT_RECEIVED", "payment", new { id = renewal.Id });
        Assert.Equal("active", await GateCheckout.SubscriptionStatus(state.Subscription));
        Assert.Null(await GateCheckout.Text($"SELECT grace_until::text FROM fluxo.billing_subscriptions WHERE id='{state.Subscription}'"));
        var start = await GateRecurrence.Moment($"SELECT current_period_start FROM fluxo.billing_subscriptions WHERE id='{state.Subscription}'");
        Assert.Equal(due.UtcDateTime.Date, start.UtcDateTime.Date);
        var retries = fake.Retries.Count;
        for (var day = 5; day <= 9; day++) await GateRecurrence.PassAsync(factory, clock, due, day);
        Assert.Equal(retries, fake.Retries.Count);
        Assert.Equal("active", await GateCheckout.SubscriptionStatus(state.Subscription));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Manual_rail_has_grace_without_retries()
    {
        await GateRecurrence.QuietAsync();
        var (fake, clock) = (new GateFakeAsaas(), new GateClock(GateRecurrence.Noon()));
        await using var factory = GateRecurrence.Api(fake, clock, automatic: false);
        var (_, _, subscription, invoice, client) = await GateRecurrence.SubscribeAsync(factory);
        using var _c = client;
        using var hook = factory.CreateClient();
        using var charged = await GateCheckout.ChargeAsync(client, invoice, $"chave-{Guid.NewGuid():N}");
        fake.Pay(fake.Payments.Keys.Single());
        await GateRecurrence.EventAsync(hook, "PAYMENT_RECEIVED", "payment", new { id = fake.Payments.Keys.Single() });
        var due = await GateRecurrence.PeriodEnd(subscription);
        clock.Now = due.AddDays(-7);
        await GateRecurrence.RunAsync(factory, GateRecurrence.Renew);
        for (var day = 1; day <= 8; day++) await GateRecurrence.PassAsync(factory, clock, due, day);
        Assert.Equal("canceled", await GateCheckout.SubscriptionStatus(subscription));
        Assert.Empty(fake.Retries);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Past_due_notice_reaches_the_owner_once_with_a_stable_id()
    {
        var (_, clock, factory, state, _, due, invoice) = await OpenAsync();
        await using var _f = factory;
        using var _c = state.Client;
        await GateRecurrence.PassAsync(factory, clock, due, 1);
        await GateRecurrence.PassAsync(factory, clock, due, 1);
        Assert.Equal(1, await GateRecurrence.Count($"SELECT count(*) FROM fluxo.user_notifications WHERE id='billing_{invoice}_billing_past_due' AND user_uid='{state.Owner}' AND type='billing_past_due'"));
    }
}
