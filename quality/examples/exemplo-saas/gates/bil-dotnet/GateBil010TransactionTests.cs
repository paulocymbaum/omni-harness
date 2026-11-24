// Gate BIL-010-PSP-FORA-DA-TRANSACAO. Template do autor de gates. A sonda olha pg_stat_activity em toda chamada ao Asaas de mentira.
using Npgsql;

namespace Fluxo.Api.Tests;

[Collection("GateBilSerial")]
public sealed class GateBil010TransactionTests
{
    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Sensor_sees_a_transaction_left_open()
    {
        const string application = "gate-bil010-sensor";
        await GateBil.ApplyMvpAsync();
        await using var connection = new NpgsqlConnection(GateProbe.Connection(application));
        await connection.OpenAsync();
        await using var transaction = await connection.BeginTransactionAsync();
        await using (var command = new NpgsqlCommand("SELECT 1", connection, transaction)) await command.ExecuteScalarAsync();
        Assert.NotNull(await GateProbe.OpenTransactionAsync(application));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Whole_recurrence_calls_the_psp_with_no_transaction_open()
    {
        await GateRecurrence.QuietAsync();
        const string application = "gate-bil010-psp";
        var (fake, clock) = (new GateFakeAsaas { ProbeApplication = application }, new GateClock(GateRecurrence.Noon()));
        await using var factory = GateRecurrence.Api(fake, clock, GateProbe.Connection(application));
        var (state, renewal, due, invoice) = await GateRecurrence.RenewedAsync(factory, fake, clock);
        using var _c = state.Client;
        using var hook = factory.CreateClient();
        using (var qr = await GateCheckout.ChargeAsync(state.Client, invoice, $"chave-{Guid.NewGuid():N}")) await GateBil.JsonAsync(qr);
        clock.Now = due;
        fake.Instructions[renewal.Instruction!] = "REFUSED";
        await GateRecurrence.EventAsync(hook, $"{GateRecurrence.Prefix}PAYMENT_INSTRUCTION_REFUSED", "paymentInstruction", new { id = renewal.Instruction, paymentId = renewal.Id });
        for (var day = 1; day <= 8; day++) await GateRecurrence.PassAsync(factory, clock, due, day);
        Assert.NotEmpty(fake.Retries);
        Assert.True(fake.ProbeCalls >= 8, $"só {fake.ProbeCalls} chamadas observadas");
        Assert.Empty(fake.Violations);
    }
}
