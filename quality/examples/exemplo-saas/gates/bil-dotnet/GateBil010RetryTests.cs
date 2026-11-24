// Gate BIL-010-RETENTATIVAS-LIMITES. Template do autor de gates. O relógio anda dia a dia e o job roda como no Cloud Run. A regra do Bacen é o teto
// real: até 3 datas, até D+7, nunca no próximo ciclo e com o mesmo valor. As sequências cobrem recusa, silêncio, HTTP 400 e pagamento.
using System.Net;
using System.Text.Json;

namespace Fluxo.Api.Tests;

[Collection("GateBilSerial")]
public sealed class GateBil010RetryTests
{
    public enum Outcome { Refused, Silent, Rejected400, Paid }

    private static async Task<GateFakeAsaas> PlayAsync(Outcome[] outcomes)
    {
        await GateRecurrence.QuietAsync();
        var (fake, clock) = (new GateFakeAsaas(), new GateClock(GateRecurrence.Noon()));
        await using var factory = GateRecurrence.Api(fake, clock);
        var (state, renewal, due, _) = await GateRecurrence.RenewedAsync(factory, fake, clock);
        using var _c = state.Client;
        using var webhook = factory.CreateClient();
        var attempts = new Queue<Outcome>(outcomes);
        var settle = new HashSet<int> { 0, 3, 5, 7 };
        for (var day = 0; day <= 9; day++)
        {
            clock.Now = due.AddDays(day);
            if (settle.Contains(day) && attempts.TryDequeue(out var outcome) && (day == 0 || fake.Retries.Any(r => r.DueDate == GateRecurrence.Date(due.AddDays(day)))))
            {
                if (outcome == Outcome.Refused)
                {
                    fake.Instructions[renewal.Instruction!] = "REFUSED";
                    await GateRecurrence.EventAsync(webhook, $"{GateRecurrence.Prefix}PAYMENT_INSTRUCTION_REFUSED", "paymentInstruction", new { id = renewal.Instruction, paymentId = renewal.Id });
                }
                else if (outcome == Outcome.Paid)
                {
                    fake.Pay(renewal.Id);
                    await GateRecurrence.EventAsync(webhook, "PAYMENT_RECEIVED", "payment", new { id = renewal.Id });
                }
                else if (outcome == Outcome.Rejected400)
                {
                    fake.Instructions[renewal.Instruction!] = "REFUSED";
                    await GateRecurrence.EventAsync(webhook, $"{GateRecurrence.Prefix}PAYMENT_INSTRUCTION_REFUSED", "paymentInstruction", new { id = renewal.Instruction, paymentId = renewal.Id });
                    fake.RetryFailure = HttpStatusCode.BadRequest;
                }
            }
            await GateRecurrence.RunAsync(factory, GateRecurrence.Dunning);
        }
        AssertLimits(fake, renewal, due);
        return fake;
    }

    private static void AssertLimits(GateFakeAsaas fake, GateFakeAsaas.Payment renewal, DateTimeOffset due)
    {
        var retries = fake.Retries.ToArray();
        string[] allowed = [GateRecurrence.Date(due.AddDays(3)), GateRecurrence.Date(due.AddDays(5)), GateRecurrence.Date(due.AddDays(7))];
        Assert.True(retries.Length <= 3, $"{retries.Length} retentativas");
        Assert.Equal(retries.Length, retries.Select(r => r.DueDate).Distinct().Count());
        Assert.All(retries, retry =>
        {
            Assert.Contains(retry.DueDate, allowed);
            // Véspera da data, sempre: o comando para D+3 sai em D+2.
            Assert.Equal(DateOnly.Parse(retry.DueDate).AddDays(-1), DateOnly.Parse(GateRecurrence.Date(retry.At)));
            var body = JsonDocument.Parse(retry.Body).RootElement;
            Assert.False(body.TryGetProperty("value", out _), "a retentativa não leva valor: é sempre o original");
            Assert.Equal(renewal.Instruction, retry.Instruction);
        });
        Assert.Equal(GateRecurrence.Value, renewal.Value);
        Assert.Single(fake.Payments.Values, p => p.Authorization == renewal.Authorization && p.Id != null);
    }

    public static TheoryData<int, Outcome[]> Sequences()
    {
        var data = new TheoryData<int, Outcome[]>
        {
            { 3, [Outcome.Refused, Outcome.Refused, Outcome.Refused, Outcome.Refused] },
            { 2, [Outcome.Refused, Outcome.Refused, Outcome.Paid] },
            { 1, [Outcome.Refused, Outcome.Paid] },
            { 0, [Outcome.Paid] },
            { 0, [Outcome.Silent, Outcome.Silent, Outcome.Silent, Outcome.Silent] },
            { 1, [Outcome.Refused, Outcome.Silent, Outcome.Silent, Outcome.Silent] },
            { 1, [Outcome.Rejected400, Outcome.Refused, Outcome.Refused] },
        };
        return data;
    }

    [Theory, MemberData(nameof(Sequences)), Trait("Category", "PostgresIntegration")]
    public async Task Sequence_stays_inside_the_limits(int expected, Outcome[] outcomes) => Assert.Equal(expected, (await PlayAsync(outcomes)).Retries.Count);

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Random_sequences_never_break_the_limits()
    {
        var random = new Random(20261101);
        for (var i = 0; i < 6; i++)
            await PlayAsync(Enumerable.Range(0, 4).Select(_ => (Outcome)random.Next(4)).ToArray());
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Rejection_400_records_the_code_and_stops_the_invoice()
    {
        await GateRecurrence.QuietAsync();
        var (fake, clock) = (new GateFakeAsaas(), new GateClock(GateRecurrence.Noon()));
        await using var factory = GateRecurrence.Api(fake, clock);
        var (state, renewal, due, invoice) = await GateRecurrence.RenewedAsync(factory, fake, clock);
        using var _c = state.Client;
        using var webhook = factory.CreateClient();
        clock.Now = due;
        fake.Instructions[renewal.Instruction!] = "REFUSED";
        await GateRecurrence.EventAsync(webhook, $"{GateRecurrence.Prefix}PAYMENT_INSTRUCTION_REFUSED", "paymentInstruction", new { id = renewal.Instruction, paymentId = renewal.Id });
        fake.RetryFailure = HttpStatusCode.BadRequest;
        for (var day = 1; day <= 8; day++) await GateRecurrence.PassAsync(factory, clock, due, day);
        Assert.Single(fake.Retries);
        Assert.Contains("invalid_action", await GateCheckout.Text($"SELECT string_agg(to_jsonb(a)::text, ' ') FROM fluxo.billing_dunning_attempts a WHERE a.invoice_id='{invoice}'"));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Attempts_are_recorded_once_per_number()
    {
        await GateRecurrence.QuietAsync();
        var (fake, clock) = (new GateFakeAsaas(), new GateClock(GateRecurrence.Noon()));
        await using var factory = GateRecurrence.Api(fake, clock);
        var (state, renewal, due, invoice) = await GateRecurrence.RenewedAsync(factory, fake, clock);
        using var _c = state.Client;
        using var webhook = factory.CreateClient();
        clock.Now = due;
        fake.Instructions[renewal.Instruction!] = "REFUSED";
        var type = $"{GateRecurrence.Prefix}PAYMENT_INSTRUCTION_REFUSED";
        await GateRecurrence.EventAsync(webhook, type, "paymentInstruction", new { id = renewal.Instruction, paymentId = renewal.Id });
        await GateRecurrence.EventAsync(webhook, type, "paymentInstruction", new { id = renewal.Instruction, paymentId = renewal.Id });
        Assert.Equal(1, await GateRecurrence.Count($"SELECT count(*) FROM fluxo.billing_dunning_attempts WHERE invoice_id='{invoice}'"));
        Assert.Equal("(invoice_id, attempt_number)", await GateCheckout.Text("""
            SELECT substring(indexdef from '\(.*\)') FROM pg_indexes WHERE schemaname='fluxo' AND tablename='billing_dunning_attempts' AND indexdef ILIKE 'CREATE UNIQUE%attempt_number%'
            """));
    }
}
