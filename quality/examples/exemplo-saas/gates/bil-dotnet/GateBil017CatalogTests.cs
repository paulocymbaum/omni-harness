// Gate BIL-017-CATALOGO-ACESSO-LEGADO. Template do autor de gates. Empresa só no Firestore (businessProfiles) lê o catálogo pelo fallback legado.
// Merchant no PostgreSQL com o ID da empresa, como depois do corte; exige FIRESTORE_EMULATOR_HOST e FLUXO_TEST_POSTGRES.
using System.Net;
using Fluxo.Api.Modules.FluxoEmpresas;

namespace Fluxo.Api.Tests;

public sealed class GateBil017CatalogTests
{
    private static DebateApiFactory Api() => new(GateBil.C, services: GateBil.LegacyDirectoryOnEmulator(), settings: GateBil.Settings());

    private static string Menu(string id) => $"/api/v1/fluxo-empresas/merchants/{id}/menu";

    private static string Categories(string id) => $"/api/v1/fluxo-empresas/merchants/{id}/categories";

    private static async Task MerchantAsync(string id, string owner)
    {
        await using var db = DebateTestDb.Context();
        db.Merchants.Add(Merchant.Create(id, id, "Empresa Gate", "other", owner, DateTimeOffset.UtcNow));
        await db.SaveChangesAsync();
    }

    private static async Task<(string Id, string Owner)> LegacyBusinessAsync(params (string Uid, string Role, string Status)[] members)
    {
        await DebateTestDb.EnsureAsync();
        var (id, owner) = ($"legacy-{Guid.NewGuid():N}", $"legacy-owner-{Guid.NewGuid():N}");
        var profile = GateBil.EmulatorDb().Collection("businessProfiles").Document(id);
        await profile.SetAsync(new Dictionary<string, object> { ["tradeName"] = "Empresa legada", ["ownerUids"] = new[] { owner } });
        foreach (var (uid, role, status) in members)
            await profile.Collection("members").Document(uid).SetAsync(new Dictionary<string, object> { ["uid"] = uid, ["role"] = role, ["status"] = status });
        await MerchantAsync(id, owner);
        return (id, owner);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Owner_only_in_firestore_reads_the_catalog()
    {
        var (id, owner) = await LegacyBusinessAsync();
        await using var factory = Api();
        using var client = factory.Client($"user:{owner}");
        using var response = await client.GetAsync(Menu(id));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public Task Active_admin_only_in_firestore_reads_the_catalog() => MemberReadsAsync("ADMIN");

    // F1.4: fora dono e ADMIN, o papel usa BusinessTeamPolicy.PermissionsFor, e business.read está em EDITOR e VIEWER.
    [Theory, Trait("Category", "PostgresIntegration")]
    [InlineData("EDITOR")]
    [InlineData("VIEWER")]
    public Task Other_roles_only_in_firestore_follow_the_policy_and_read_the_catalog(string role) => MemberReadsAsync(role);

    private static async Task MemberReadsAsync(string role)
    {
        var member = $"legacy-{role.ToLowerInvariant()}-{Guid.NewGuid():N}";
        var (id, _) = await LegacyBusinessAsync((member, role, "active"));
        await using var factory = Api();
        using var client = factory.Client($"user:{member}");
        using var response = await client.GetAsync(Menu(id));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Stranger_and_revoked_member_get_403()
    {
        var revoked = $"legacy-revoked-{Guid.NewGuid():N}";
        var (id, _) = await LegacyBusinessAsync((revoked, "ADMIN", "revoked"));
        await using var factory = Api();
        foreach (var uid in new[] { "estranho", revoked })
        {
            using var client = factory.Client($"user:{uid}");
            using var response = await client.GetAsync(Menu(id));
            Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        }
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Legacy_role_keeps_the_permissions_of_the_policy_on_write()
    {
        var (editor, viewer) = ($"legacy-editor-{Guid.NewGuid():N}", $"legacy-viewer-{Guid.NewGuid():N}");
        var (id, _) = await LegacyBusinessAsync((editor, "EDITOR", "active"), (viewer, "VIEWER", "active"));
        await using var factory = Api();
        using var denied = await DebateApiFactory.SendAsync(factory.Client($"user:{viewer}"), HttpMethod.Post, Categories(id), new { name = "Bebidas" });
        Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        using var created = await DebateApiFactory.SendAsync(factory.Client($"user:{editor}"), HttpMethod.Post, Categories(id), new { name = "Bebidas" });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Postgres_owner_and_member_stay_the_same()
    {
        var (id, owner) = await GateBil.SeedBusinessAsync();
        await MerchantAsync(id, owner);
        var viewer = await GateBil.SeedMemberAsync(id, "VIEWER");
        await using var factory = Api();
        using var read = await factory.Client($"user:{owner}").GetAsync(Menu(id));
        Assert.Equal(HttpStatusCode.OK, read.StatusCode);
        using var member = await factory.Client($"user:{viewer}").GetAsync(Menu(id));
        Assert.Equal(HttpStatusCode.OK, member.StatusCode);
        using var denied = await DebateApiFactory.SendAsync(factory.Client($"user:{viewer}"), HttpMethod.Post, Categories(id), new { name = "Bebidas" });
        Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
    }
}
