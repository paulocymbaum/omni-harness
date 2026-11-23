// Gate BIL-009-SEM-PSP-NO-HANDLER. Template do autor de gates. O gateway deste teste lança e conta ao ser tocado.
namespace Fluxo.Api.Tests;

[Collection("GateBilSerial")]
public sealed class GateBil009NoPspTests
{
    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task No_write_route_touches_the_gateway()
    {
        var psp = new GatePsp { Forbidden = true };
        await using var factory = GateCheckout.Api(psp);
        var open = await GateAdmin.SeedAsync(factory);
        var other = await GateAdmin.SeedAsync(factory);
        var paid = await GateAdmin.SeedAsync(factory, "paid", "paid", "active");
        using var client = GateAdmin.Client(factory, "billing.manage", "billing.refund");
        var calls = new (string Route, object Body)[]
        {
            ($"/webhooks/{open.QuarantinedEvent}/replay", new { reason = GateAdmin.Reason }),
            ($"/charges/{paid.Charge}/refund", new { reason = GateAdmin.Reason }),
            ($"/invoices/{open.Invoice}/mark-paid", new { reason = GateAdmin.Reason, evidence = "Comprovante conferido" }),
            ($"/invoices/{other.Invoice}/void", new { reason = GateAdmin.Reason }),
        };
        foreach (var (route, body) in calls)
        {
            using var response = await GateAdmin.PostAsync(client, route, body);
            Assert.True(response.IsSuccessStatusCode, $"{route}: {(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
        }
        Assert.Equal(0, psp.Touches);
        Assert.Equal("pending", await GateCheckout.Text($"SELECT status FROM fluxo.billing_webhook_events WHERE id='{open.QuarantinedEvent}'"));
        Assert.Equal("refund_pending", await GateCheckout.Text($"SELECT status FROM fluxo.billing_charges WHERE id='{paid.Charge}'"));
    }
}
