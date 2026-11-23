// Gate BIL-010-QR-MESMA-COBRANCA. Template do autor de gates. O QR é sempre da mesma cobrança: cobrança nova abriria caminho para débito em dobro.
using System.Text.Json;

namespace Fluxo.Api.Tests;

[Collection("GateBilSerial")]
public sealed class GateBil010QrTests
{
    private static async Task<(GateFakeAsaas Fake, GateClock Clock, DebateApiFactory Factory, GateAuto State, GateFakeAsaas.Payment Renewal, DateTimeOffset Due, Guid Invoice)> OpenAsync()
    {
        await GateRecurrence.QuietAsync();
        var (fake, clock) = (new GateFakeAsaas(), new GateClock(GateRecurrence.Noon()));
        var factory = GateRecurrence.Api(fake, clock);
        var (state, renewal, due, invoice) = await GateRecurrence.RenewedAsync(factory, fake, clock);
        return (fake, clock, factory, state, renewal, due, invoice);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Charges_on_a_recurrence_invoice_read_the_qr_and_never_create_a_second_charge()
    {
        var (fake, _, factory, state, renewal, _, invoice) = await OpenAsync();
        await using var _f = factory;
        using var _c = state.Client;
        var posts = fake.Posts("/v3/payments").Count();
        for (var i = 0; i < 2; i++)
        {
            using var response = await GateCheckout.ChargeAsync(state.Client, invoice, $"chave-{Guid.NewGuid():N}");
            Assert.Equal($"br-{renewal.Id}", (await GateBil.JsonAsync(response)).GetProperty("brCode").GetString());
        }
        Assert.Equal(posts, fake.Posts("/v3/payments").Count());
        Assert.Equal(1, await GateRecurrence.Count($"SELECT count(DISTINCT external_charge_id) FROM fluxo.billing_charges WHERE invoice_id='{invoice}'"));
        Assert.Contains(fake.Http.Calls, c => c is { Method: "GET" } && c.PathAndQuery == $"/v3/payments/{renewal.Id}/pixQrCode");
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Qr_stays_available_on_an_overdue_invoice()
    {
        var (_, clock, factory, state, renewal, due, invoice) = await OpenAsync();
        await using var _f = factory;
        using var _c = state.Client;
        await GateRecurrence.PassAsync(factory, clock, due, 2);
        using var response = await GateCheckout.ChargeAsync(state.Client, invoice, $"chave-{Guid.NewGuid():N}");
        Assert.Equal($"br-{renewal.Id}", (await GateBil.JsonAsync(response)).GetProperty("brCode").GetString());
    }

    [Theory, Trait("Category", "PostgresIntegration")]
    [InlineData(-3, 12, false)] // fora da janela
    [InlineData(-1, 25, true)]  // 22h de D-1 no Brasil são 01h de D em UTC
    [InlineData(0, 12, true)]   // dia da liquidação
    public async Task Answer_warns_when_the_provider_blocks_another_way_of_paying(int day, int hourUtc, bool blocked)
    {
        var (_, clock, factory, state, _, due, invoice) = await OpenAsync();
        await using var _f = factory;
        using var _c = state.Client;
        clock.Now = new DateTimeOffset(due.UtcDateTime.Date, TimeSpan.Zero).AddDays(day).AddHours(hourUtc);
        using var response = await GateCheckout.ChargeAsync(state.Client, invoice, $"chave-{Guid.NewGuid():N}");
        var body = await GateBil.JsonAsync(response);
        Assert.Equal(blocked, body.TryGetProperty("qrBlockedUntil", out var until) && until.ValueKind == JsonValueKind.String);
    }

    [Theory, Trait("Category", "PostgresIntegration")]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Paying_by_qr_with_both_events_in_any_order_makes_one_transition(bool paymentFirst)
    {
        var (fake, clock, factory, state, renewal, due, invoice) = await OpenAsync();
        await using var _f = factory;
        using var _c = state.Client;
        using var hook = factory.CreateClient();
        clock.Now = due.AddDays(-2);
        fake.Pay(renewal.Id, "CONFIRMED");
        fake.Instructions[renewal.Instruction!] = "CANCELLED";
        var payment = () => GateRecurrence.EventAsync(hook, "PAYMENT_CONFIRMED", "payment", new { id = renewal.Id });
        var canceled = () => GateRecurrence.EventAsync(hook, $"{GateRecurrence.Prefix}PAYMENT_INSTRUCTION_CANCELLED", "paymentInstruction", new { id = renewal.Instruction, paymentId = renewal.Id });
        await (paymentFirst ? payment : canceled)();
        await (paymentFirst ? canceled : payment)();
        Assert.Equal("paid", await GateCheckout.InvoiceStatus(invoice));
        Assert.Equal("active", await GateCheckout.SubscriptionStatus(state.Subscription));
        Assert.Equal(due.AddMonths(1).UtcDateTime.Date, (await GateRecurrence.PeriodEnd(state.Subscription)).UtcDateTime.Date);
    }
}
