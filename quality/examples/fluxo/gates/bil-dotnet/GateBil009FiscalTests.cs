// Gate BIL-009-SEM-DADO-FISCAL. Template do autor de gates. Documento fictício. Olha o texto inteiro de cada resposta e os logs.
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Fluxo.Api.Tests;

[Collection("GateBilSerial")]
public sealed class GateBil009FiscalTests
{
    private static void AssertClean(string text, GateLedger ledger, string envelope, string hmac, string where)
    {
        foreach (var banned in new[] { "rawBody", "raw_body", "taxIdCiphertext", "tax_id_ciphertext", "taxIdHmac", "tax_id_hmac", ledger.Marker, GateAdmin.RawTaxId, GateAdmin.TypedTaxId, envelope, hmac })
            Assert.False(text.Contains(banned, StringComparison.OrdinalIgnoreCase), $"{where} contém {banned[..Math.Min(banned.Length, 12)]}");
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task No_route_or_log_carries_raw_body_or_clear_document()
    {
        var logs = new GateLogs();
        await using var factory = GateCheckout.Api(new GatePsp(), more: s => s.AddSingleton<ILoggerProvider>(logs));
        var ledger = await GateAdmin.SeedAsync(factory);
        var envelope = (await GateCheckout.Text($"SELECT tax_id_ciphertext FROM fluxo.billing_customers WHERE id='{ledger.Customer}'"))!;
        var hmac = (await GateCheckout.Text($"SELECT tax_id_hmac FROM fluxo.billing_customers WHERE id='{ledger.Customer}'"))!;
        using var client = GateAdmin.Client(factory, "billing.read");
        var routes = GateAdmin.ReadRoutes(ledger).Append($"{GateAdmin.Base}/subscriptions?search={GateAdmin.RawTaxId}");
        foreach (var route in routes)
        {
            using var response = await client.GetAsync(route);
            var text = await response.Content.ReadAsStringAsync();
            Assert.True(response.IsSuccessStatusCode, $"{route}: {(int)response.StatusCode}");
            AssertClean(text, ledger, envelope, hmac, route.Split('?')[0]);
        }
        AssertClean(logs.All, ledger, envelope, hmac, "log");
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Subscription_detail_shows_the_mask()
    {
        await using var factory = GateCheckout.Api(new GatePsp());
        var ledger = await GateAdmin.SeedAsync(factory);
        using var client = GateAdmin.Client(factory, "billing.read");
        using var response = await client.GetAsync($"{GateAdmin.Base}/subscriptions/{ledger.Subscription}");
        Assert.Contains(GateAdmin.Mask, GateBil.Strings(await GateBil.JsonAsync(response)));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Webhook_list_has_only_the_operational_fields()
    {
        await using var factory = GateCheckout.Api(new GatePsp());
        var ledger = await GateAdmin.SeedAsync(factory);
        using var client = GateAdmin.Client(factory, "billing.read");
        using var response = await client.GetAsync($"{GateAdmin.Base}/webhooks?status=quarantined&limit=100");
        var item = (await GateBil.JsonAsync(response)).GetProperty("items").EnumerateArray().Single(x => x.GetProperty("id").GetString() == ledger.QuarantinedEvent.ToString());
        Assert.Equal("PAYMENT_RECEIVED", item.GetProperty("eventType").GetString());
        Assert.Equal("quarantined", item.GetProperty("status").GetString());
        Assert.Equal(3, item.GetProperty("attempts").GetInt32());
        Assert.Equal("amount_mismatch", item.GetProperty("lastError").GetString());
        Assert.Equal(ledger.ExternalCharge, item.GetProperty("externalChargeId").GetString());
        Assert.True(item.TryGetProperty("receivedAt", out _));
    }
}
