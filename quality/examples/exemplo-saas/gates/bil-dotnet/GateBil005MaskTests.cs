// Gate BIL-005-SO-MASCARA. Template do autor de gates. Documento fictício, alfanumérico, sem relação com empresa real.
// `address` vai como objeto: a spec não fixa a forma, e o esquema da arquitetura usa colunas address_*.
using System.Net;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Fluxo.Api.Tests;

public sealed class GateBil005MaskTests
{
    private const string Raw = "12ABC34501DE35";
    private const string Typed = "12.ABC.345/01DE-35";
    private const string Mask = "**.***.345/****-35";

    private static DebateApiFactory Api(GateLogs logs) => new(GateBil.C, s => s.AddSingleton<ILoggerProvider>(logs), GateBil.Settings(GateCrypto.Keys()));

    private static string Route(string id) => $"/api/v1/billing/subjects/business/{id}/customer";

    private static object Body(string taxId) => new
    {
        legalName = "Empresa Gate LTDA", taxId, billingEmail = "financeiro@example.test",
        address = new { street = "Rua do Gate", number = "1", district = "Centro", city = "Belo Horizonte", state = "MG", postalCode = "30000000" },
    };

    private static void AssertNoRaw(string text)
    {
        Assert.DoesNotContain(Raw, text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(Typed, text, StringComparison.OrdinalIgnoreCase);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Put_and_get_expose_only_the_mask_and_never_log_the_value()
    {
        var (id, owner) = await GateBil.SeedBusinessAsync();
        var logs = new GateLogs();
        await using var factory = Api(logs);
        using var client = factory.Client($"user:{owner}");
        using (var put = await DebateApiFactory.SendAsync(client, HttpMethod.Put, Route(id), Body(Typed)))
        {
            var text = await put.Content.ReadAsStringAsync();
            Assert.True(put.IsSuccessStatusCode, $"HTTP {(int)put.StatusCode}: {text}");
            AssertNoRaw(text);
        }
        using (var get = await client.GetAsync(Route(id)))
        {
            var text = await get.Content.ReadAsStringAsync();
            AssertNoRaw(text);
            var body = await GateBil.JsonAsync(get);
            Assert.Equal(Mask, body.GetProperty("taxIdMasked").GetString());
            Assert.Equal("Empresa Gate LTDA", body.GetProperty("legalName").GetString());
            Assert.False(body.TryGetProperty("taxId", out _), "resposta não pode trazer taxId");
        }
        AssertNoRaw(logs.All);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Database_keeps_ciphertext_hmac_and_mask_and_audit_keeps_only_the_mask()
    {
        var (id, owner) = await GateBil.SeedBusinessAsync();
        var logs = new GateLogs();
        await using var factory = Api(logs);
        using var client = factory.Client($"user:{owner}");
        using (var put = await DebateApiFactory.SendAsync(client, HttpMethod.Put, Route(id), Body(Typed)))
            Assert.True(put.IsSuccessStatusCode, await put.Content.ReadAsStringAsync());
        var select = $"FROM fluxo.billing_customers c WHERE c.subject_id='{id}'";
        AssertNoRaw(await DebateTestDb.ScalarAsync<string>(GateBil.C, $"SELECT to_jsonb(c)::text {select}") ?? "linha ausente");
        var envelope = await DebateTestDb.ScalarAsync<string>(GateBil.C, $"SELECT tax_id_ciphertext {select}");
        var customer = await DebateTestDb.ScalarAsync<Guid>(GateBil.C, $"SELECT id {select}");
        var protector = GateProtector.From(factory);
        Assert.Equal(Raw, protector.Unprotect(envelope!, $"billing_customer:{customer}:tax_id"));
        Assert.Equal(protector.Blind(Raw, "billing.tax_id"), await DebateTestDb.ScalarAsync<string>(GateBil.C, $"SELECT tax_id_hmac {select}"));
        Assert.Equal(Mask, await DebateTestDb.ScalarAsync<string>(GateBil.C, $"SELECT tax_id_mask {select}"));
        var audit = await GateBil.RowsAsync(GateBil.C, $"SELECT to_jsonb(e)::text FROM fluxo.billing_audit_events e WHERE to_jsonb(e)::text LIKE '%{customer}%' OR to_jsonb(e)::text LIKE '%{id}%'");
        Assert.NotEmpty(audit);
        Assert.All(audit, AssertNoRaw);
    }

    [Theory, Trait("Category", "PostgresIntegration")]
    [InlineData("123")]
    [InlineData("12ABC34501DE3")]
    [InlineData("12ABC34501DE355")]
    public async Task Invalid_tax_id_is_refused(string taxId)
    {
        var (id, owner) = await GateBil.SeedBusinessAsync();
        await using var factory = Api(new GateLogs());
        using var client = factory.Client($"user:{owner}");
        using var response = await DebateApiFactory.SendAsync(client, HttpMethod.Put, Route(id), Body(taxId));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        Assert.Equal("invalid_tax_id", await DebateApiFactory.CodeAsync(response));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Same_tax_id_may_belong_to_more_than_one_registration()
    {
        var first = await GateBil.SeedBusinessAsync();
        var second = await GateBil.SeedBusinessAsync();
        await using var factory = Api(new GateLogs());
        foreach (var (id, owner) in new[] { first, second })
        {
            using var client = factory.Client($"user:{owner}");
            using var response = await DebateApiFactory.SendAsync(client, HttpMethod.Put, Route(id), Body(Typed));
            Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        }
        var index = Assert.Single(await GateBil.RowsAsync(GateBil.C, "SELECT indexdef FROM pg_indexes WHERE schemaname='fluxo' AND indexname='ix_billing_customers_tax_id_hmac'"));
        Assert.DoesNotContain("UNIQUE", index);
    }
}
