// Gates de API da FC-019 (template). API completa por DevApiFactory (SEM RemoveAll do verificador: o registro real,
// com o decorador quando Enabled, é o que roda). PG via GateFc (FLUXO_TEST_POSTGRES); emulador via FIRESTORE_EMULATOR_HOST.
// Nenhum uid, e-mail ou businessId real: tudo sintético gerado na hora.
using System.Net;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Fluxo.Api.Tests;

public sealed class GateFc019ApiTests
{
    private static string Role(JsonElement body)
    {
        var access = body.GetProperty("access");
        return access.GetProperty("role").GetString()!.ToLowerInvariant();
    }

    private static string? Detail(JsonElement body) =>
        body.ValueKind == JsonValueKind.Object && body.TryGetProperty("detail", out var detail) ? detail.GetString() : null;

    [Fact]
    public async Task Disabled_override_rejects_dev_tokens_and_malformed_tokens_with_401_without_echoing()
    {
        var uid = GateDev.NewUid();
        await using var factory = new DevApiFactory(null, settings: GateDev.DevSettings(false, ""));
        using (var client = factory.Client(GateDev.Dev(uid)))
        {
            var (status, body, raw) = await GateFc.GetAsync(client, GateDev.Config("gate-biz-disabled"));
            Assert.Equal(401, status);
            Assert.Equal("invalid_firebase_credential", GateFc.Code(body));
            var text = await raw.Content.ReadAsStringAsync(CancellationToken.None);
            Assert.DoesNotContain(uid, text);
        }
        // Um token que não é `dev.` (e não é JWT) segue pelo verificador real e continua 401 como antes.
        using (var malformed = factory.Client("garbage-not-a-jwt"))
        {
            var (status, body, _) = await GateFc.GetAsync(malformed, GateDev.Config("gate-biz-disabled"));
            Assert.Equal(401, status);
            Assert.Equal("invalid_firebase_credential", GateFc.Code(body));
        }
        // Um dev.<uid> com Enabled ausente (padrão do appsettings) também é recusado.
        var minimal = new Dictionary<string, string?> { ["Creator:Enabled"] = "true", ["Homologacao:Creator:Mode"] = "Allowlist" };
        await using var defaultOff = new DevApiFactory(null, settings: minimal);
        using (var offClient = defaultOff.Client(GateDev.Dev(uid)))
        {
            var (status, body, _) = await GateFc.GetAsync(offClient, GateDev.Config("gate-biz-disabled"));
            Assert.Equal(401, status);
            Assert.Equal("invalid_firebase_credential", GateFc.Code(body));
        }
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Listed_uid_reads_config_while_unlisted_and_case_variants_get_401()
    {
        var (business, owner) = await GateFc.SeedBusinessAsync();
        await using var factory = GateDev.Api(GateDev.DevSettings(true, owner, owner));
        using (var listed = factory.Client(GateDev.Dev(owner)))
            Assert.Equal(200, (await GateFc.GetAsync(listed, GateDev.Config(business))).Status);
        using (var stranger = factory.Client(GateDev.Dev(GateDev.NewUid())))
        {
            var (status, body, raw) = await GateFc.GetAsync(stranger, GateDev.Config(business));
            Assert.Equal(401, status);
            Assert.Equal("invalid_firebase_credential", GateFc.Code(body));
            Assert.DoesNotContain(owner, await raw.Content.ReadAsStringAsync(CancellationToken.None));
        }
        using (var caseMismatch = factory.Client(GateDev.Dev(owner.ToUpperInvariant())))
        {
            var (status, body, _) = await GateFc.GetAsync(caseMismatch, GateDev.Config(business));
            Assert.Equal(401, status); // comparação ordinal: caixa difere, token recusado
            Assert.Equal("invalid_firebase_credential", GateFc.Code(body));
        }
    }


    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Dev_tokens_never_open_admin_routes_even_with_a_seeded_grant()
    {
        var uid = GateDev.NewUid();
        await GateDev.SeedAdminGrantAsync(uid); // mesmo com grant ativo no emulador…
        await using var factory = GateDev.Api(GateDev.DevSettings(true, uid));
        using var client = factory.Client(GateDev.Dev(uid));
        var (getStatus, getBody, _) = await GateFc.GetAsync(client, GateDev.AdminCompanies);
        Assert.Equal(HttpStatusCode.Forbidden, (HttpStatusCode)getStatus);
        Assert.Equal("admin_required", GateFc.Code(getBody)); // …o filtro de admin recusa antes de tudo
        var write = await DebateApiFactory.SendAsync(client, HttpMethod.Put,
            GateDev.AdminGrant("artist", $"gate-entity-{Guid.NewGuid():N}", uid),
            new { permissions = new[] { "agenda.manage" }, evidenceReference = "gate-evidence" });
        Assert.Equal(HttpStatusCode.Forbidden, write.StatusCode);
        Assert.Contains("admin_required", await write.Content.ReadAsStringAsync(CancellationToken.None), StringComparison.Ordinal);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Closed_homologacao_answers_the_same_404_as_a_disabled_feature()
    {
        var uid = GateDev.NewUid();
        var business = GateDev.NewBiz();
        await using var closed = GateDev.Api(GateDev.DevSettings(true, uid, homologacaoUids: ""));
        var closedResult = await GateFc.GetAsync(closed.Client(GateDev.Dev(uid)), GateDev.Config(business));
        GateHom.AssertDisabled404(closedResult, "homologação fechada com token dev");
        await using var disabled = GateDev.Api(GateDev.DevSettings(true, uid, homologacaoUids: "", mode: "Allowlist", ("Creator:Enabled", "false")));
        var disabledResult = await GateFc.GetAsync(disabled.Client(GateDev.Dev(uid)), GateDev.Config(business));
        Assert.Equal(404, disabledResult.Status);
        Assert.Equal(GateFc.Code(closedResult.Body), GateFc.Code(disabledResult.Body)); // mesmo código…
        Assert.Equal(Detail(closedResult.Body), Detail(disabledResult.Body)); // …e o mesmo detalhe do recurso desligado
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Owner_and_member_paths_keep_working_and_rn02_roles_still_apply()
    {
        var (business, owner) = await GateFc.SeedBusinessAsync();
        var viewer = await GateFc.SeedMemberAsync(business, "VIEWER");
        var operatorUid = await GateFc.SeedMemberAsync(business, "OPERATOR");
        // Homologação lista SÓ o dono: membros passam por ViaOwner; autenticação é do override, autorização é a real.
        await using var factory = GateDev.Api(GateDev.DevSettings(true, $"{owner},{viewer},{operatorUid}", owner));
        var palette = new { colors = new[] { "#101010", "#F0F0F0" } };
        using (var ownerClient = factory.Client(GateDev.Dev(owner)))
        {
            var (status, body, _) = await GateFc.GetAsync(ownerClient, GateDev.Config(business));
            Assert.Equal(200, status);
            Assert.Equal("owner", Role(body));
            Assert.Equal(HttpStatusCode.OK, (await DebateApiFactory.SendAsync(ownerClient, HttpMethod.Put,
                GateDev.Kit(business, "/palette"), palette)).StatusCode);
        }
        using (var viewerClient = factory.Client(GateDev.Dev(viewer)))
        {
            var (status, body, _) = await GateFc.GetAsync(viewerClient, GateDev.Config(business));
            Assert.Equal(200, status);
            Assert.Equal("viewer", Role(body)); // membro ativo liberado pelo dono listado, papel intacto
            Assert.Equal(HttpStatusCode.Forbidden, (await DebateApiFactory.SendAsync(viewerClient, HttpMethod.Put,
                GateDev.Kit(business, "/palette"), palette)).StatusCode); // RN-02: VIEWER não escreve
        }
        using (var operatorClient = factory.Client(GateDev.Dev(operatorUid)))
        {
            var put = await DebateApiFactory.SendAsync(operatorClient, HttpMethod.Put,
                GateDev.Kit(business, "/palette"), palette);
            Assert.Equal(HttpStatusCode.Forbidden, put.StatusCode);
            Assert.Equal("creator_access_denied", await DebateApiFactory.CodeAsync(put)); // papel legado fora da política
        }
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Seeded_legacy_owner_reads_the_config_as_owner()
    {
        var uid = Environment.GetEnvironmentVariable("FLUXO_GATE_SEED_UID");
        var business = Environment.GetEnvironmentVariable("FLUXO_GATE_SEED_BIZ");
        Assert.False(string.IsNullOrWhiteSpace(uid), "FLUXO_GATE_SEED_UID ausente (o gate do seed define)");
        Assert.False(string.IsNullOrWhiteSpace(business), "FLUXO_GATE_SEED_BIZ ausente (o gate do seed define)");
        // Conta só no legado do emulador (seed-firestore.mjs): a API local precisa enxergar o dono por lá.
        await using var factory = GateDev.Api(GateDev.DevSettings(true, uid!, uid!), emulator: true);
        using var client = factory.Client(GateDev.Dev(uid!));
        var (status, body, _) = await GateFc.GetAsync(client, GateDev.Config(business!));
        Assert.Equal(200, status);
        Assert.Equal("owner", Role(body));
    }
}