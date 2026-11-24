// Gate BIL-010-EVENTOS-PIX-AUTOMATICO. Template do autor de gates. Jornada 3 e cada evento da tabela da spec, pelo webhook real.
using System.Net;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Fluxo.Api.Tests;

[Collection("GateBilSerial")]
public sealed class GateBil010EventTests
{
    private const string P = GateRecurrence.Prefix;

    private static async Task<(GateFakeAsaas Fake, GateClock Clock, DebateApiFactory Factory, GateAuto State, HttpClient Hook)> OpenAsync(bool automatic = true, GateLogs? logs = null)
    {
        await GateRecurrence.QuietAsync();
        var (fake, clock) = (new GateFakeAsaas(), new GateClock(GateRecurrence.Noon()));
        var factory = GateRecurrence.Api(fake, clock, automatic: automatic, more: logs is null ? null : s => s.AddSingleton<ILoggerProvider>(logs));
        return (fake, clock, factory, automatic ? await GateRecurrence.AuthorizeAsync(factory, fake) : null!, factory.CreateClient());
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Flag_off_keeps_the_manual_checkout_and_never_opens_an_authorization()
    {
        var (fake, _, factory, _, hook) = await OpenAsync(automatic: false);
        await using var _f = factory;
        using var _h = hook;
        var (_, _, _, invoice, client) = await GateRecurrence.SubscribeAsync(factory);
        using var _c = client;
        using var manual = await GateRecurrence.ChargeAsync(client, invoice, "pix_automatico");
        Assert.Empty(fake.Posts("/v3/pix/automatic/authorizations"));
        Assert.Equal(0, await GateRecurrence.Count($"SELECT count(*) FROM fluxo.billing_charges WHERE invoice_id='{invoice}' AND rail<>'pix_manual'"));
        using var plain = await GateCheckout.ChargeAsync(client, invoice, $"chave-{Guid.NewGuid():N}");
        Assert.Equal(HttpStatusCode.OK, plain.StatusCode);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Authorization_goes_as_manual_without_value_with_three_in_seven_days()
    {
        var (fake, _, factory, state, hook) = await OpenAsync();
        await using var _f = factory;
        using var _c = state.Client;
        using var _h = hook;
        var body = JsonDocument.Parse(Assert.Single(fake.Posts("/v3/pix/automatic/authorizations")).Body).RootElement;
        Assert.Equal("MANUAL", body.GetProperty("paymentCreationMode").GetString());
        Assert.Equal("ALLOW_THREE_IN_SEVEN_DAYS", body.GetProperty("retryPolicy").GetString());
        Assert.False(body.TryGetProperty("value", out _), "autorização sem valor fixo");
        Assert.False(body.TryGetProperty("finishDate", out _), "a autorização não usa finishDate");
        Assert.Equal(state.Subscription.ToString(), body.GetProperty("contractId").GetString());
        Assert.Equal(GateRecurrence.Value, body.GetProperty("immediateQrCode").GetProperty("originalValue").GetDecimal());
        Assert.True(body.GetProperty("immediateQrCode").GetProperty("expirationSeconds").GetInt32() > 0);
        Assert.True(body.TryGetProperty("frequency", out _));
        Assert.True(body.TryGetProperty("startDate", out _));
        Assert.Equal("pending", await GateRecurrence.Instrument(state.Authorization));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Charge_answers_the_qr_of_the_authorization_without_a_psp_id_beyond_it()
    {
        await GateRecurrence.QuietAsync();
        var (fake, clock) = (new GateFakeAsaas(), new GateClock(GateRecurrence.Noon()));
        await using var factory = GateRecurrence.Api(fake, clock);
        var (_, _, _, invoice, client) = await GateRecurrence.SubscribeAsync(factory);
        using var _c = client;
        using var charged = await GateRecurrence.ChargeAsync(client, invoice, "pix_automatico");
        var body = await GateBil.JsonAsync(charged);
        var authorization = Assert.Single(fake.Authorizations.Keys);
        Assert.Equal($"br-{authorization}", body.GetProperty("brCode").GetString());
        Assert.StartsWith("data:image/", body.GetProperty("qrImageDataUri").GetString());
        Assert.Equal(authorization, body.GetProperty("authorizationId").GetString());
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Paid_releases_the_plan_and_only_activated_turns_the_instrument_on()
    {
        var (fake, _, factory, state, hook) = await OpenAsync();
        await using var _f = factory;
        using var _c = state.Client;
        using var _h = hook;
        await GateRecurrence.PayFirstAsync(hook, fake, state, activate: false);
        Assert.Equal("active", await GateCheckout.SubscriptionStatus(state.Subscription));
        Assert.Equal("pending", await GateRecurrence.Instrument(state.Authorization));
        Assert.Equal("pix_manual", await GateRecurrence.Rail(state.Subscription));
        await GateRecurrence.EventAsync(hook, $"{P}AUTHORIZATION_ACTIVATED", "authorization", new { id = state.Authorization });
        Assert.Equal("active", await GateRecurrence.Instrument(state.Authorization));
        Assert.Equal("pix_automatico", await GateRecurrence.Rail(state.Subscription));
        Assert.Equal(state.Authorization, await GateCheckout.Text($"SELECT authorization_id FROM fluxo.billing_subscriptions WHERE id='{state.Subscription}'"));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Refused_before_paying_revokes_and_stays_incomplete()
    {
        var (_, _, factory, state, hook) = await OpenAsync();
        await using var _f = factory;
        using var _c = state.Client;
        using var _h = hook;
        await GateRecurrence.EventAsync(hook, $"{P}AUTHORIZATION_REFUSED", "authorization", new { id = state.Authorization });
        Assert.Equal("revoked", await GateRecurrence.Instrument(state.Authorization));
        Assert.Equal("incomplete", await GateCheckout.SubscriptionStatus(state.Subscription));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Refused_after_paying_keeps_the_plan_without_refund_and_falls_back_to_manual()
    {
        var (fake, _, factory, state, hook) = await OpenAsync();
        await using var _f = factory;
        using var _c = state.Client;
        using var _h = hook;
        await GateRecurrence.PayFirstAsync(hook, fake, state, activate: false);
        await GateRecurrence.EventAsync(hook, $"{P}AUTHORIZATION_REFUSED", "authorization", new { id = state.Authorization });
        Assert.Equal("active", await GateCheckout.SubscriptionStatus(state.Subscription));
        Assert.Equal("revoked", await GateRecurrence.Instrument(state.Authorization));
        Assert.Equal("pix_manual", await GateRecurrence.Rail(state.Subscription));
        Assert.DoesNotContain(fake.Http.Calls, c => c.PathAndQuery.EndsWith("/refund", StringComparison.Ordinal));
    }

    [Theory, Trait("Category", "PostgresIntegration")]
    [InlineData("AUTHORIZATION_CANCELLED")]
    [InlineData("AUTHORIZATION_EXPIRED")]
    public async Task Canceled_at_the_bank_is_reflected_without_a_click_and_never_becomes_past_due_inside_the_paid_cycle(string type)
    {
        var (fake, clock, factory, state, hook) = await OpenAsync();
        await using var _f = factory;
        using var _c = state.Client;
        using var _h = hook;
        await GateRecurrence.PayFirstAsync(hook, fake, state);
        fake.Authorizations[state.Authorization] = "CANCELLED";
        await GateRecurrence.EventAsync(hook, $"{P}{type}", "authorization", new { id = state.Authorization, cancellationReason = "PAYER_CANCELLED" });
        Assert.Equal("revoked", await GateRecurrence.Instrument(state.Authorization));
        Assert.Equal("pix_manual", await GateRecurrence.Rail(state.Subscription));
        if (type.EndsWith("CANCELLED", StringComparison.Ordinal))
            Assert.Contains("PAYER_CANCELLED", await GateCheckout.Text($"SELECT to_jsonb(i)::text FROM fluxo.billing_instruments i WHERE pix_authorization_id='{state.Authorization}'"));
        var end = await GateRecurrence.PeriodEnd(state.Subscription);
        for (var day = -5; day <= -1; day++) await GateRecurrence.PassAsync(factory, clock, end, day);
        Assert.Equal("active", await GateCheckout.SubscriptionStatus(state.Subscription));
    }

    [Theory, Trait("Category", "PostgresIntegration")]
    [InlineData("PAYMENT_INSTRUCTION_REFUSED", 1)]
    [InlineData("PAYMENT_INSTRUCTION_CANCELLED", 1)]
    public async Task Instruction_events_record_the_attempt_and_do_not_move_the_subscription(string type, int rows)
    {
        await GateRecurrence.QuietAsync();
        var (fake, clock) = (new GateFakeAsaas(), new GateClock(GateRecurrence.Noon()));
        await using var factory = GateRecurrence.Api(fake, clock);
        var (state, renewal, due, invoice) = await GateRecurrence.RenewedAsync(factory, fake, clock);
        using var _c = state.Client;
        using var hook = factory.CreateClient();
        clock.Now = due;
        await GateRecurrence.EventAsync(hook, $"{P}{type}", "paymentInstruction", new { id = renewal.Instruction, paymentId = renewal.Id });
        Assert.Equal(rows, await GateRecurrence.Count($"SELECT count(*) FROM fluxo.billing_dunning_attempts WHERE invoice_id='{invoice}'"));
        Assert.Equal("active", await GateCheckout.SubscriptionStatus(state.Subscription));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Ineligible_account_logs_and_blocks_new_authorizations()
    {
        var logs = new GateLogs();
        var (fake, _, factory, state, hook) = await OpenAsync(logs: logs);
        await using var _f = factory;
        using var _c = state.Client;
        using var _h = hook;
        await GateRecurrence.EventAsync(hook, $"{P}ELIGIBILITY_UPDATED", "eligibility", new { status = "INELIGIBLE" });
        Assert.Contains("billing_pix_automatico_ineligible", logs.All);
        Assert.Equal("pending", await GateRecurrence.Instrument(state.Authorization));
        var before = fake.Posts("/v3/pix/automatic/authorizations").Count();
        var (_, _, _, invoice, client) = await GateRecurrence.SubscribeAsync(factory);
        using var _d = client;
        using var blocked = await GateRecurrence.ChargeAsync(client, invoice, "pix_automatico");
        Assert.Equal(before, fake.Posts("/v3/pix/automatic/authorizations").Count());
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Psp_refusing_the_authorization_is_treated_as_ineligible()
    {
        var logs = new GateLogs();
        await GateRecurrence.QuietAsync();
        var (fake, clock) = (new GateFakeAsaas(), new GateClock(GateRecurrence.Noon()));
        await using var factory = GateRecurrence.Api(fake, clock, more: s => s.AddSingleton<ILoggerProvider>(logs));
        var (_, _, _, invoice, client) = await GateRecurrence.SubscribeAsync(factory);
        using var _c = client;
        fake.AuthorizationFailure = HttpStatusCode.BadRequest;
        using var refused = await GateRecurrence.ChargeAsync(client, invoice, "pix_automatico");
        Assert.Contains("billing_pix_automatico_ineligible", logs.All);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Repeated_event_makes_one_transition()
    {
        var (fake, _, factory, state, hook) = await OpenAsync();
        await using var _f = factory;
        using var _c = state.Client;
        using var _h = hook;
        await GateRecurrence.PayFirstAsync(hook, fake, state, activate: false);
        var type = $"{P}AUTHORIZATION_ACTIVATED";
        var id = await GateRecurrence.EventAsync(hook, type, "authorization", new { id = state.Authorization });
        await GateRecurrence.EventAsync(hook, type, "authorization", new { id = state.Authorization }, id);
        Assert.Equal(1, await GateRecurrence.Count($"SELECT count(*) FROM fluxo.billing_webhook_events WHERE provider_event_id='{id}'"));
        Assert.Equal(1, await GateRecurrence.Count($"SELECT count(*) FROM fluxo.billing_instruments WHERE pix_authorization_id='{state.Authorization}'"));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Past_due_subscription_can_be_canceled_by_the_portal()
    {
        await GateRecurrence.QuietAsync();
        var (fake, clock) = (new GateFakeAsaas(), new GateClock(GateRecurrence.Noon()));
        await using var factory = GateRecurrence.Api(fake, clock);
        var (state, _, due, _) = await GateRecurrence.RenewedAsync(factory, fake, clock);
        using var _c = state.Client;
        await GateRecurrence.PassAsync(factory, clock, due, 1);
        Assert.Equal("past_due", await GateCheckout.SubscriptionStatus(state.Subscription));
        using var canceled = await DebateApiFactory.SendAsync(state.Client, HttpMethod.Post, $"/api/v1/billing/subscriptions/{state.Subscription}/cancel", new { reason = "Empresa encerrou as atividades" });
        Assert.True(canceled.IsSuccessStatusCode, await canceled.Content.ReadAsStringAsync());
    }
}
