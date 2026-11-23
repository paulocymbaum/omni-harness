// Gate BIL-010-JOB-IDEMPOTENTE. Template do autor de gates. Job repetido no mesmo dia, job perdido e cada caso que não renova.
using System.Net;

namespace Fluxo.Api.Tests;

[Collection("GateBilSerial")]
public sealed class GateBil010JobTests
{
    private static async Task<(GateFakeAsaas Fake, GateClock Clock, DebateApiFactory Factory, GateAuto State, DateTimeOffset Due)> ActiveAsync()
    {
        await GateRecurrence.QuietAsync();
        var (fake, clock) = (new GateFakeAsaas(), new GateClock(GateRecurrence.Noon()));
        var factory = GateRecurrence.Api(fake, clock);
        var state = await GateRecurrence.AuthorizeAsync(factory, fake);
        using var hook = factory.CreateClient();
        await GateRecurrence.PayFirstAsync(hook, fake, state);
        return (fake, clock, factory, state, await GateRecurrence.PeriodEnd(state.Subscription));
    }

    private static Task<long> Invoices(Guid subscription) => GateRecurrence.Count($"SELECT count(*) FROM fluxo.billing_invoices WHERE subscription_id='{subscription}'");

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Renewal_at_seven_days_charges_on_the_authorization_with_the_period_end_as_due_date()
    {
        var (fake, clock, factory, state, due) = await ActiveAsync();
        await using var _f = factory;
        using var _c = state.Client;
        clock.Now = due.AddDays(-8);
        await GateRecurrence.RunAsync(factory, GateRecurrence.Renew);
        Assert.Equal(1, await Invoices(state.Subscription));
        clock.Now = due.AddDays(-7);
        await GateRecurrence.RunAsync(factory, GateRecurrence.Renew);
        Assert.Equal(2, await Invoices(state.Subscription));
        var created = Assert.Single(fake.Payments.Values, p => p.Authorization == state.Authorization);
        Assert.Equal(GateRecurrence.Date(due), created.DueDate);
        Assert.Equal(GateRecurrence.Value, created.Value);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Repeating_both_jobs_does_not_duplicate_invoice_charge_or_retry()
    {
        var (fake, clock, factory, state, due) = await ActiveAsync();
        await using var _f = factory;
        using var _c = state.Client;
        using var hook = factory.CreateClient();
        clock.Now = due.AddDays(-7);
        for (var i = 0; i < 3; i++) await GateRecurrence.RunAsync(factory, GateRecurrence.Renew);
        Assert.Equal(2, await Invoices(state.Subscription));
        var renewal = Assert.Single(fake.Payments.Values, p => p.Authorization == state.Authorization);
        clock.Now = due;
        fake.Instructions[renewal.Instruction!] = "REFUSED";
        await GateRecurrence.EventAsync(hook, $"{GateRecurrence.Prefix}PAYMENT_INSTRUCTION_REFUSED", "paymentInstruction", new { id = renewal.Instruction, paymentId = renewal.Id });
        clock.Now = due.AddDays(2);
        for (var i = 0; i < 3; i++) await GateRecurrence.RunAsync(factory, GateRecurrence.Dunning);
        Assert.Single(fake.Retries);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Period_unique_index_blocks_a_second_invoice_even_without_the_job()
    {
        await GateBil.ApplyMvpAsync();
        Assert.Contains("subscription_id, period_start", await GateCheckout.Text("""
            SELECT indexdef FROM pg_indexes WHERE schemaname='fluxo' AND tablename='billing_invoices' AND indexdef ILIKE 'CREATE UNIQUE%period_start%'
            """));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Late_job_goes_as_manual_for_that_cycle_and_keeps_the_instruction_window()
    {
        var (fake, clock, factory, state, due) = await ActiveAsync();
        await using var _f = factory;
        using var _c = state.Client;
        clock.Now = due.AddDays(-3);
        await GateRecurrence.RunAsync(factory, GateRecurrence.Renew);
        var late = Assert.Single(fake.Payments.Values, p => p.Id != null && !string.IsNullOrEmpty(p.ExternalReference));
        Assert.Null(late.Authorization);
        Assert.Equal("pix_manual", await GateCheckout.Text($"SELECT rail FROM fluxo.billing_charges WHERE external_charge_id='{late.Id}'"));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Pending_cancellation_does_not_renew()
    {
        var (fake, clock, factory, state, due) = await ActiveAsync();
        await using var _f = factory;
        using var _c = state.Client;
        await DebateTestDb.ExecAsync(GateBil.C, $"UPDATE fluxo.billing_subscriptions SET status='pending_cancellation', cancel_at_period_end=true WHERE id='{state.Subscription}'");
        var payments = fake.Payments.Count;
        clock.Now = due.AddDays(-7);
        await GateRecurrence.RunAsync(factory, GateRecurrence.Renew);
        Assert.Equal(1, await Invoices(state.Subscription));
        Assert.Equal(payments, fake.Payments.Count);
    }

    [Theory, Trait("Category", "PostgresIntegration")]
    [InlineData("manual", 3900)]
    [InlineData("pix_manual", 0)]
    public async Task Manual_plan_and_zero_value_do_not_invoice(string rail, long cents)
    {
        var (fake, clock, factory, state, due) = await ActiveAsync();
        await using var _f = factory;
        using var _c = state.Client;
        await DebateTestDb.ExecAsync(GateBil.C, $"""
            UPDATE fluxo.billing_subscriptions SET rail='{rail}' WHERE id='{state.Subscription}';
            UPDATE fluxo.billing_prices SET amount_cents={cents} WHERE id=(SELECT price_id FROM fluxo.billing_subscriptions WHERE id='{state.Subscription}');
            """);
        var payments = fake.Payments.Count;
        clock.Now = due.AddDays(-7);
        await GateRecurrence.RunAsync(factory, GateRecurrence.Renew);
        Assert.Equal(1, await Invoices(state.Subscription));
        Assert.Equal(payments, fake.Payments.Count);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Two_jobs_at_once_make_one_charge()
    {
        var (fake, clock, factory, state, due) = await ActiveAsync();
        await using var _f = factory;
        using var _c = state.Client;
        clock.Now = due.AddDays(-7);
        await Task.WhenAll(GateRecurrence.RunAsync(factory, GateRecurrence.Renew), GateRecurrence.RunAsync(factory, GateRecurrence.Renew));
        Assert.Single(fake.Payments.Values, p => p.Authorization == state.Authorization);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Upgrade_makes_a_prorated_invoice_without_touching_the_psp()
    {
        var (fake, clock, factory, state, due) = await ActiveAsync();
        await using var _f = factory;
        using var _c = state.Client;
        var richer = await GateCheckout.SeedPriceAsync(7800);
        var code = await DebateTestDb.ScalarAsync<string>(GateBil.C, $"SELECT {GateCheckout.ProductCode(richer)}");
        clock.Now = due.AddDays(-15);
        var calls = fake.Http.Calls.Count;
        using var response = await DebateApiFactory.SendAsync(state.Client, HttpMethod.Post, $"/api/v1/billing/subscriptions/{state.Subscription}/change-plan", new { productCode = code, priceId = richer });
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        Assert.Equal(calls, fake.Http.Calls.Count);
        var total = await DebateTestDb.ScalarAsync<long>(GateBil.C, $"SELECT total_cents FROM fluxo.billing_invoices WHERE subscription_id='{state.Subscription}' AND status='open'");
        Assert.InRange(total, 1, 3899);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Downgrade_waits_for_the_end_of_the_cycle_and_past_due_refuses_any_change()
    {
        var (_, clock, factory, state, due) = await ActiveAsync();
        await using var _f = factory;
        using var _c = state.Client;
        var cheaper = await GateCheckout.SeedPriceAsync(1900);
        var code = await DebateTestDb.ScalarAsync<string>(GateBil.C, $"SELECT {GateCheckout.ProductCode(cheaper)}");
        var route = $"/api/v1/billing/subscriptions/{state.Subscription}/change-plan";
        using (var response = await DebateApiFactory.SendAsync(state.Client, HttpMethod.Post, route, new { productCode = code, priceId = cheaper }))
            Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        Assert.Equal(cheaper.ToString(), await GateCheckout.Text($"SELECT scheduled_price_id::text FROM fluxo.billing_subscriptions WHERE id='{state.Subscription}'"));
        await DebateTestDb.ExecAsync(GateBil.C, $"UPDATE fluxo.billing_subscriptions SET status='past_due' WHERE id='{state.Subscription}'");
        using var refused = await DebateApiFactory.SendAsync(state.Client, HttpMethod.Post, route, new { productCode = code, priceId = cheaper });
        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
        Assert.Equal("billing_subscription_past_due", await DebateApiFactory.CodeAsync(refused));
    }
}
