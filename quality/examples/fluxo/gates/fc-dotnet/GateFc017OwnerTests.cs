// Gate FC-017-DONO-LIBERA-CONTA (template). PostgreSQL + emulador Firestore (FIRESTORE_EMULATOR_HOST): a conta é liberada quando um DONO
// dela tem o uid em Homologacao:Creator:AllowedUserUids; o dono herdeiro vale só por uid (nunca por e-mail do perfil); membro ativo entra
// de qualquer papel e o papel segue valendo (RN-02). Valores sintéticos: uids gerados, e-mails `*@example.test`.
using Microsoft.Extensions.DependencyInjection;

namespace Fluxo.Api.Tests;

public sealed class GateFc017OwnerTests
{
    private static object PaletteBody() => new { colors = new[] { "#FFFFFF", "#000000" } };

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task A_listed_owner_releases_every_active_member_and_the_role_still_applies()
    {
        var (id, owner) = await GateFc.SeedBusinessAsync();
        var members = new Dictionary<string, string>
        {
            ["admin"] = await GateFc.SeedMemberAsync(id, "ADMIN"), ["editor"] = await GateFc.SeedMemberAsync(id, "EDITOR"), ["viewer"] = await GateFc.SeedMemberAsync(id, "VIEWER"),
        };
        var revoked = await GateFc.SeedMemberAsync(id, "EDITOR");
        await GateHom.RevokeAsync(id, revoked);
        var (otherId, otherOwner) = await GateFc.SeedBusinessAsync();
        var otherMember = await GateFc.SeedMemberAsync(otherId, "ADMIN");
        await using var factory = GateHom.Api("Allowlist", new Lists(Uids: owner), emulator: true);

        using var ownerClient = factory.Client($"user:{owner}");
        var ownerConfig = await GateFc.GetAsync(ownerClient, GateHom.Config(id));
        Assert.Equal(200, ownerConfig.Status);
        Assert.Equal("owner", ownerConfig.Body.GetProperty("access").GetProperty("role").GetString());
        Assert.Equal(200, await GateHom.StatusAsync(ownerClient, GateHom.Ufs));

        foreach (var (role, uid) in members)
        {
            using var client = factory.Client($"user:{uid}");
            var config = await GateFc.GetAsync(client, GateHom.Config(id));
            Assert.True(config.Status == 200, $"{role}: /config HTTP {config.Status}");
            Assert.Equal(role, config.Body.GetProperty("access").GetProperty("role").GetString());
            Assert.Equal(200, (await GateFc.GetAsync(client, GateHom.Kit(id))).Status);
            Assert.Equal(200, await GateHom.StatusAsync(client, GateHom.Geo(id)));
            GateHom.AssertDisabled404(await GateFc.GetAsync(client, GateHom.Ufs), $"{role} /geo sem businessId (só o uid abre sem conta)");
            var write = await GateFc2.CallAsync(client, HttpMethod.Put, GateHom.Kit(id, "/palette"), PaletteBody());
            if (role == "admin") Assert.Equal(200, write.Status);
            else
            {
                Assert.Equal(403, write.Status);
                Assert.Equal("creator_permission_denied", GateFc.Code(write.Body));
            }
        }

        using var stranger = factory.Client($"user:{GateHom.NewUid("gate-stranger")}");
        GateHom.AssertDisabled404(await GateFc.GetAsync(stranger, GateHom.Config(id)), "não membro");
        using var revokedClient = factory.Client($"user:{revoked}");
        GateHom.AssertDisabled404(await GateFc.GetAsync(revokedClient, GateHom.Config(id)), "membro revogado");

        // Dono não autorizado nega os membros dele (e a si mesmo).
        using var otherMemberClient = factory.Client($"user:{otherMember}");
        GateHom.AssertDisabled404(await GateFc.GetAsync(otherMemberClient, GateHom.Config(otherId)), "membro de conta com dono não listado");
        using var otherOwnerClient = factory.Client($"user:{otherOwner}");
        GateHom.AssertDisabled404(await GateFc.GetAsync(otherOwnerClient, GateHom.Config(otherId)), "dono não listado");
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task An_owner_listed_only_by_email_passes_himself_but_his_members_do_not_inherit()
    {
        var (id, owner) = await GateFc.SeedBusinessAsync();
        var member = await GateFc.SeedMemberAsync(id, "ADMIN");
        var email = GateHom.NewEmail();
        await using var factory = GateHom.Api("Allowlist", new Lists(Uids: GateHom.NewUid(), Emails: email), emulator: true);
        using var ownerClient = factory.Client(GateHom.Token(owner, email, "true"));
        Assert.Equal(200, (await GateFc.GetAsync(ownerClient, GateHom.Config(id))).Status);
        using var memberClient = factory.Client($"user:{member}");
        GateHom.AssertDisabled404(await GateFc.GetAsync(memberClient, GateHom.Config(id)), "membro de dono listado só por e-mail");
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task The_profile_email_of_the_owner_never_releases_the_account()
    {
        var (id, owner) = await GateFc.SeedBusinessAsync();
        var member = await GateFc.SeedMemberAsync(id, "ADMIN");
        var email = GateHom.NewEmail();
        await GateHom.SetProfileEmailAsync(owner, email);
        await using var factory = GateHom.Api("Allowlist", new Lists(Uids: GateHom.NewUid(), Emails: email), emulator: true);
        using var memberClient = factory.Client($"user:{member}");
        GateHom.AssertDisabled404(await GateFc.GetAsync(memberClient, GateHom.Config(id)), "membro, e-mail do perfil do dono listado");
        using var memberVerified = factory.Client(GateHom.Token(member, GateHom.NewEmail(), "true"));
        GateHom.AssertDisabled404(await GateFc.GetAsync(memberVerified, GateHom.Config(id)), "membro verificado, e-mail do perfil do dono listado");
        using var ownerClient = factory.Client($"user:{owner}");
        GateHom.AssertDisabled404(await GateFc.GetAsync(ownerClient, GateHom.Config(id)), "dono com o e-mail do perfil listado mas token sem e-mail verificado");
    }

    private static async Task<(string Id, string Owner, string Member)> SeedLegacyAsync()
    {
        await DebateTestDb.EnsureAsync();
        var (id, owner, member) = ($"gate-legacy-{Guid.NewGuid():N}", GateHom.NewUid("gate-legacy-owner"), GateHom.NewUid("gate-legacy-member"));
        var business = GateHom.EmulatorDb().Collection("businessProfiles").Document(id);
        await business.SetAsync(new Dictionary<string, object> { ["tradeName"] = "Empresa legada gate", ["ownerUids"] = new[] { owner } });
        await business.Collection("members").Document(member).SetAsync(new Dictionary<string, object> { ["role"] = "VIEWER", ["status"] = "active" });
        return (id, owner, member);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task A_business_only_in_the_legacy_directory_inherits_the_same_way()
    {
        var (id, owner, member) = await SeedLegacyAsync();
        await using var factory = GateHom.Api("Allowlist", new Lists(Uids: owner), emulator: true);
        using var ownerClient = factory.Client($"user:{owner}");
        Assert.Equal(200, (await GateFc.GetAsync(ownerClient, GateHom.Config(id))).Status);
        using var memberClient = factory.Client($"user:{member}");
        var config = await GateFc.GetAsync(memberClient, GateHom.Config(id));
        Assert.Equal(200, config.Status);
        Assert.Equal("viewer", config.Body.GetProperty("access").GetProperty("role").GetString());
        using var stranger = factory.Client($"user:{GateHom.NewUid("gate-stranger")}");
        GateHom.AssertDisabled404(await GateFc.GetAsync(stranger, GateHom.Config(id)), "estranho da conta legada");

        await using var unlisted = GateHom.Api("Allowlist", new Lists(Uids: GateHom.NewUid()), emulator: true);
        using var unlistedMember = unlisted.Client($"user:{member}");
        GateHom.AssertDisabled404(await GateFc.GetAsync(unlistedMember, GateHom.Config(id)), "membro legado com dono não listado");
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Owner_resolution_follows_the_team_service_precedence_without_an_actor()
    {
        var (id, owner) = await GateFc.SeedBusinessAsync();
        var (legacyId, legacyOwner, _) = await SeedLegacyAsync();
        await using var factory = GateHom.Api("Open", emulator: true);
        using var scope = factory.Services.CreateScope();
        var service = scope.ServiceProvider.GetRequiredService(GateFc.Find("BusinessTeamService"));
        var method = service.GetType().GetMethod("GetOwnerUidsAsync");
        Assert.True(method is not null, "BusinessTeamService sem GetOwnerUidsAsync público");

        async Task<string[]> Owners(string business)
        {
            var task = (Task)GateHom.Call(method!, service, business, CancellationToken.None)!;
            await task;
            return ((IReadOnlyList<string>)task.GetType().GetProperty("Result")!.GetValue(task)!).ToArray();
        }

        Assert.Equal([owner], await Owners(id));
        Assert.Equal([legacyOwner], await Owners(legacyId));
        Assert.Empty(await Owners($"gate-none-{Guid.NewGuid():N}"));
    }
}
