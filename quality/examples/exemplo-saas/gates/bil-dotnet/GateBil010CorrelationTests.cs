// Gate BIL-010-CORRELACAO-PRIMEIRA-COBRANCA. Template do autor de gates. A cobrança inicial da Jornada 3 nasce no Asaas sem externalReference do Fluxo.
using System.Net;

namespace Fluxo.Api.Tests;

[Collection("GateBilSerial")]
public sealed class GateBil010CorrelationTests
{
    private static async Task<(GateFakeAsaas Fake, DebateApiFactory Factory, GateAuto State, HttpClient Hook)> OpenAsync()
    {
        await GateRecurrence.QuietAsync();
        var (fake, clock) = (new GateFakeAsaas(), new GateClock(GateRecurrence.Noon()));
        var factory = GateRecurrence.Api(fake, clock);
        return (fake, factory, await GateRecurrence.AuthorizeAsync(factory, fake), factory.CreateClient());
    }

    private static Task<string> PaidAsync(HttpClient hook, GateFakeAsaas.Payment payment) => GateRecurrence.EventAsync(hook, "PAYMENT_RECEIVED", "payment", new { id = payment.Id });

    private static Task DuplicateCandidateAsync(Guid invoice) => DebateTestDb.ExecAsync(GateBil.C, $"""
        INSERT INTO fluxo.billing_charges(id,invoice_id,rail,amount_cents,status,attempt_number,client_key,external_authorization_id,created_at,updated_at)
        SELECT gen_random_uuid(),invoice_id,rail,amount_cents,'pending',attempt_number+1,gen_random_uuid()::text,external_authorization_id,created_at,updated_at
        FROM fluxo.billing_charges WHERE invoice_id='{invoice}'
        """);

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task One_candidate_links_and_activates()
    {
        var (fake, factory, state, hook) = await OpenAsync();
        await using var _f = factory;
        using var _c = state.Client;
        using var _h = hook;
        var payment = fake.FirstCharge(state.Customer, state.Value);
        var id = await PaidAsync(hook, payment);
        Assert.Equal("processed", await GateCheckout.EventStatus(id));
        Assert.Equal("active", await GateCheckout.SubscriptionStatus(state.Subscription));
        Assert.Equal(state.Invoice.ToString(), await GateCheckout.Text($"SELECT invoice_id::text FROM fluxo.billing_charges WHERE external_charge_id='{payment.Id}'"));
        Assert.Equal(state.Authorization, await GateCheckout.Text($"SELECT external_authorization_id FROM fluxo.billing_charges WHERE external_charge_id='{payment.Id}'"));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Two_candidates_stay_in_quarantine_without_transition()
    {
        var (fake, factory, state, hook) = await OpenAsync();
        await using var _f = factory;
        using var _c = state.Client;
        using var _h = hook;
        await DuplicateCandidateAsync(state.Invoice);
        var id = await PaidAsync(hook, fake.FirstCharge(state.Customer, state.Value));
        Assert.Equal("quarantined", await GateCheckout.EventStatus(id));
        Assert.Equal("incomplete", await GateCheckout.SubscriptionStatus(state.Subscription));
    }

    [Theory, Trait("Category", "PostgresIntegration")]
    [InlineData("value")]
    [InlineData("customer")]
    [InlineData("created-later")]
    public async Task No_candidate_stays_in_quarantine_without_transition(string difference)
    {
        var (fake, factory, state, hook) = await OpenAsync();
        await using var _f = factory;
        using var _c = state.Client;
        using var _h = hook;
        if (difference == "created-later")
            await DebateTestDb.ExecAsync(GateBil.C, $"UPDATE fluxo.billing_charges SET created_at = now() + interval '30 days' WHERE invoice_id='{state.Invoice}'");
        var payment = fake.FirstCharge(difference == "customer" ? "cus_outra_empresa" : state.Customer, difference == "value" ? 38.99m : state.Value);
        var id = await PaidAsync(hook, payment);
        Assert.Equal("quarantined", await GateCheckout.EventStatus(id));
        Assert.Equal("incomplete", await GateCheckout.SubscriptionStatus(state.Subscription));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Conciliation_identifier_decides_between_two_candidates()
    {
        var (fake, factory, state, hook) = await OpenAsync();
        await using var _f = factory;
        using var _c = state.Client;
        using var _h = hook;
        await DuplicateCandidateAsync(state.Invoice);
        var id = await PaidAsync(hook, fake.FirstCharge(state.Customer, state.Value, conciliation: $"con-{state.Authorization}"));
        Assert.Equal("processed", await GateCheckout.EventStatus(id));
        Assert.Equal("active", await GateCheckout.SubscriptionStatus(state.Subscription));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Event_of_a_charge_the_psp_does_not_know_is_still_ignored()
    {
        var (_, factory, state, hook) = await OpenAsync();
        await using var _f = factory;
        using var _c = state.Client;
        using var _h = hook;
        var id = await GateRecurrence.EventAsync(hook, "PAYMENT_RECEIVED", "payment", new { id = "pay_forjado" });
        Assert.NotEqual("processed", await GateCheckout.EventStatus(id));
        Assert.Equal("incomplete", await GateCheckout.SubscriptionStatus(state.Subscription));
    }
}
