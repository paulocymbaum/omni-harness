// Gate BIL-002-DOTNET-TESTES (API). Template do autor de gates. Só HTTP e SQL. Dono e ADMIN autorizam pelo PostgreSQL, sem Firestore.
using System.Net;

namespace Fluxo.Api.Tests;

public sealed class GateBil002ApiTests
{
    private static DebateApiFactory Api() => new(GateBil.C, settings: GateBil.Settings());

    private static string Route(string type, string id, string leaf) => $"/api/v1/billing/subjects/{type}/{id}/{leaf}";

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Catalog_is_anonymous_and_lists_only_active_products()
    {
        await GateBil.ApplyMvpAsync();
        await using var factory = Api();
        using var client = factory.CreateClient();
        using var response = await client.GetAsync("/api/v1/billing/catalog?audience=business");
        var strings = GateBil.Strings(await GateBil.JsonAsync(response)).ToHashSet();
        Assert.Contains("presenca", strings);
        Assert.Empty(strings.Intersect(["local", "pro", "rede"]));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Catalog_stays_read_only_for_anonymous_callers()
    {
        await GateBil.ApplyMvpAsync();
        await using var factory = Api();
        using var client = factory.CreateClient();
        using (var read = await client.GetAsync("/api/v1/billing/catalog?audience=business"))
            Assert.Equal(HttpStatusCode.OK, read.StatusCode);
        using var write = await DebateApiFactory.SendAsync(client, HttpMethod.Post, "/api/v1/billing/catalog", new { });
        Assert.Equal(HttpStatusCode.Unauthorized, write.StatusCode);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Subject_routes_answer_401_to_anonymous_and_200_to_owner_and_admin_member()
    {
        var (id, owner) = await GateBil.SeedBusinessAsync();
        var admin = await GateBil.SeedMemberAsync(id, "ADMIN");
        await using var factory = Api();
        using var anonymous = factory.CreateClient();
        using var ownerClient = factory.Client($"user:{owner}");
        using var adminClient = factory.Client($"user:{admin}");
        foreach (var leaf in new[] { "entitlements", "subscription", "invoices" })
        {
            using (var r = await anonymous.GetAsync(Route("business", id, leaf)))
                Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
            using (var r = await ownerClient.GetAsync(Route("business", id, leaf)))
                Assert.Equal(HttpStatusCode.OK, r.StatusCode);
            using (var r = await adminClient.GetAsync(Route("business", id, leaf)))
                Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        }
    }

    [Theory, Trait("Category", "PostgresIntegration")]
    [InlineData("artist")]
    [InlineData("collective")]
    [InlineData("person")]
    public async Task Subject_types_other_than_business_are_not_supported(string type)
    {
        await DebateTestDb.EnsureAsync();
        await using var factory = Api();
        using var client = factory.Client("user:qualquer");
        using var response = await client.GetAsync(Route(type, "algum-id", "entitlements"));
        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        Assert.Equal("billing_subject_not_supported", await DebateApiFactory.CodeAsync(response));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Business_without_subscription_resolves_to_presenca_by_default()
    {
        var (id, owner) = await GateBil.SeedBusinessAsync();
        await using var factory = Api();
        using var client = factory.Client($"user:{owner}");
        using var response = await client.GetAsync(Route("business", id, "entitlements"));
        var body = await GateBil.JsonAsync(response);
        Assert.Equal("presenca", body.GetProperty("planCode").GetString());
        Assert.Equal("default", body.GetProperty("source").GetString());
    }
}
