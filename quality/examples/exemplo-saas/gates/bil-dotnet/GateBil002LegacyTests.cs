// Gate BIL-002-ACESSO-LEGADO. Template do autor de gates. EDITOR, VIEWER e empresa só no Firestore passam pelo fallback de
// RequireAccessAsync, que consulta o Firestore. Exige FIRESTORE_EMULATOR_HOST; a API do teste aponta para o emulador.
using System.Net;

namespace Fluxo.Api.Tests;

public sealed class GateBil002LegacyTests
{
    private static DebateApiFactory Api() => new(GateBil.C, services: GateBil.LegacyDirectoryOnEmulator(), settings: GateBil.Settings());

    private static string Entitlements(string id) => $"/api/v1/billing/subjects/business/{id}/entitlements";

    [Theory, Trait("Category", "PostgresIntegration")]
    [InlineData("EDITOR")]
    [InlineData("VIEWER")]
    public async Task Members_below_admin_are_forbidden(string role)
    {
        var (id, owner) = await GateBil.SeedBusinessAsync();
        var member = await GateBil.SeedMemberAsync(id, role);
        await using var factory = Api();
        using var ownerClient = factory.Client($"user:{owner}");
        using (var control = await ownerClient.GetAsync(Entitlements(id)))
            Assert.Equal(HttpStatusCode.OK, control.StatusCode);
        using var client = factory.Client($"user:{member}");
        using var response = await client.GetAsync(Entitlements(id));
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Business_only_in_firestore_authorizes_through_the_legacy_fallback()
    {
        await DebateTestDb.EnsureAsync();
        var id = $"legacy-{Guid.NewGuid():N}";
        var owner = $"legacy-owner-{Guid.NewGuid():N}";
        await GateBil.EmulatorDb().Collection("businessProfiles").Document(id).SetAsync(new Dictionary<string, object>
        {
            ["tradeName"] = "Empresa legada", ["ownerUids"] = new[] { owner },
        });
        await using var factory = Api();
        using var client = factory.Client($"user:{owner}");
        using var response = await client.GetAsync(Entitlements(id));
        Assert.Equal("presenca", (await GateBil.JsonAsync(response)).GetProperty("planCode").GetString());
        using var stranger = factory.Client("user:estranho");
        using var denied = await stranger.GetAsync(Entitlements(id));
        Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
    }
}
