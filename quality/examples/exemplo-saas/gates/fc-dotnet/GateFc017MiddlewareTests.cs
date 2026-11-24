// Gates FC-017-BILLING-CONFIG (mecanismo opt-in) e FC-017-FEATURE-SEM-ENTRADA-ABERTA (template). Sem PostgreSQL e sem rota real:
// endpoint de teste (DefaultHttpContext + SetEndpoint) com HomologacaoRequirement e o middleware real vindo da DI.
// Nenhuma rota de Billing é tocada: `billing` é só a chave sintética do mecanismo. Valores sintéticos.
namespace Fluxo.Api.Tests;

public sealed class GateFc017MiddlewareTests
{
    private static HomHost Billing(string uids = "gate-user-a", string emails = "gate-mail-a@example.test", string businesses = "gate-biz-b") =>
        GateHom.Host(GateHom.Lists3("Billing", uids, emails, businesses));

    private static void AssertDenied(GateHom.Outcome outcome, string what, string code = "homologacao_not_available", string detail = "This feature is not available.")
    {
        Assert.True(outcome.Denied is not null, $"{what}: deveria negar");
        Assert.False(outcome.NextCalled, $"{what}: não pode seguir adiante");
        Assert.Equal(404, outcome.Denied!.StatusCode);
        Assert.Equal(code, outcome.Denied.Code);
        Assert.Equal(detail, outcome.Denied.Detail);
    }

    private static void AssertAllowed(GateHom.Outcome outcome, string what)
    {
        Assert.True(outcome.Denied is null, $"{what}: não deveria negar ({outcome.Denied?.Code})");
        Assert.True(outcome.NextCalled, $"{what}: deveria seguir adiante");
    }

    [Fact]
    public async Task Billing_requirement_closed_denies_with_the_default_404_and_user_rules_open_the_door()
    {
        var requirement = GateHom.Requirement("billing");
        using (var closed = GateHom.Host(GateHom.Lists3("Billing")))
        {
            AssertDenied(await GateHom.RunMiddlewareAsync(closed, requirement, GateHom.User("gate-user-a", "gate-mail-a@example.test", verified: true)), "fechado");
            AssertDenied(await GateHom.RunMiddlewareAsync(closed, requirement, GateHom.User("gate-user-a"), route: "gate-biz-b"), "fechado com businessId");
            Assert.Equal(0, closed.Probe.Calls);
        }
        using var host = Billing();
        AssertAllowed(await GateHom.RunMiddlewareAsync(host, requirement, GateHom.User("gate-user-a")), "uid listado");
        AssertAllowed(await GateHom.RunMiddlewareAsync(host, requirement, GateHom.User("gate-user-z", "gate-mail-a@EXAMPLE.test", verified: true)), "e-mail verificado");
        AssertDenied(await GateHom.RunMiddlewareAsync(host, requirement, GateHom.User("gate-user-z", "gate-mail-a@example.test", verified: false)), "e-mail não verificado");
        AssertDenied(await GateHom.RunMiddlewareAsync(host, requirement, GateHom.User("gate-user-z")), "usuário fora da lista");
        AssertDenied(await GateHom.RunMiddlewareAsync(host, requirement, null), "sem usuário");
        Assert.Equal(0, host.Probe.Calls);

        var custom = GateHom.Requirement("billing", "billing_disabled", "Billing is not available.");
        AssertDenied(await GateHom.RunMiddlewareAsync(host, custom, GateHom.User("gate-user-z")), "texto do metadado", "billing_disabled", "Billing is not available.");
    }

    [Fact]
    public async Task Billing_requirement_releases_by_owner_or_business_list_only_with_an_active_link()
    {
        var requirement = GateHom.Requirement("billing");
        using var host = Billing();
        var member = GateHom.User("gate-user-m", "gate-mail-m@example.test", verified: true);

        host.Probe.Member = (_, _) => true;
        host.Probe.Owners = _ => ["gate-user-a"];
        AssertAllowed(await GateHom.RunMiddlewareAsync(host, requirement, member, route: "gate-biz-1"), "dono listado (valor de rota)");
        AssertAllowed(await GateHom.RunMiddlewareAsync(host, requirement, member, query: "?businessId=gate-biz-1"), "dono listado (query)");
        host.Probe.Member = (_, _) => false;
        AssertDenied(await GateHom.RunMiddlewareAsync(host, requirement, member, route: "gate-biz-1"), "dono listado sem vínculo ativo");

        host.Probe.Member = (_, _) => true;
        host.Probe.Owners = _ => Array.Empty<string>();
        AssertAllowed(await GateHom.RunMiddlewareAsync(host, requirement, member, route: "gate-biz-b"), "válvula");
        host.Probe.Member = (_, _) => false;
        AssertDenied(await GateHom.RunMiddlewareAsync(host, requirement, member, route: "gate-biz-b"), "válvula sem vínculo ativo");

        // businessId repetido, vazio ou inválido vale como ausente: só a regra 1 resta.
        host.Probe.Member = (_, _) => true;
        host.Probe.Owners = _ => ["gate-user-a"];
        AssertDenied(await GateHom.RunMiddlewareAsync(host, requirement, member, query: "?businessId=gate-biz-1&businessId=gate-biz-1"), "businessId repetido");
        AssertDenied(await GateHom.RunMiddlewareAsync(host, requirement, member, query: "?businessId="), "businessId vazio");
        AssertDenied(await GateHom.RunMiddlewareAsync(host, requirement, member, query: "?businessId=a%2Fb"), "businessId com barra");
        AssertDenied(await GateHom.RunMiddlewareAsync(host, requirement, member), "sem businessId");

        // O nome do parâmetro vem do metadado (rotas como subjects/{type}/{id}).
        var byId = GateHom.Requirement("billing", parameter: "id");
        AssertAllowed(await GateHom.RunMiddlewareAsync(host, byId, member, route: "gate-biz-1", routeName: "id"), "parâmetro id");
        AssertDenied(await GateHom.RunMiddlewareAsync(host, byId, member, route: "gate-biz-1", routeName: "businessId"), "parâmetro errado");
    }

    [Fact]
    public async Task Feature_without_an_entry_opens_for_any_user_without_touching_the_probe()
    {
        using var host = GateHom.Host(GateHom.Lists3("gate-other", "gate-user-a"));
        var requirement = GateHom.Requirement("gate-feature");
        AssertAllowed(await GateHom.RunMiddlewareAsync(host, requirement, GateHom.User("gate-user-z")), "usuário qualquer");
        AssertAllowed(await GateHom.RunMiddlewareAsync(host, requirement, null), "sem usuário");
        AssertAllowed(await GateHom.RunMiddlewareAsync(host, requirement, GateHom.User("gate-user-z"), route: "gate-biz-1"), "com businessId");
        Assert.Equal(0, host.Probe.Calls);
        AssertDenied(await GateHom.RunMiddlewareAsync(host, GateHom.Requirement("gate-other"), GateHom.User("gate-user-z")), "outra funcionalidade segue restrita");
    }

    [Fact]
    public async Task Endpoint_without_the_metadata_passes_without_resolving_any_service()
    {
        using var host = GateHom.Host(GateHom.Lists3("billing"));
        var strict = new StrictServices();
        AssertAllowed(await GateHom.RunMiddlewareAsync(host, null, GateHom.User("gate-user-z"), requestServices: strict), "sem metadado");
        AssertAllowed(await GateHom.RunMiddlewareAsync(host, null, null, route: "gate-biz-1", requestServices: strict), "sem metadado nem usuário");
        Assert.Equal(0, strict.Calls);
        Assert.Equal(0, host.Probe.Calls);
    }

    [Fact]
    public async Task Removing_the_entry_reopens_the_same_route_without_changing_it()
    {
        var requirement = GateHom.Requirement("gate-feature");
        var stranger = GateHom.User("gate-user-z");
        using (var restricted = GateHom.Host(GateHom.Lists3("gate-feature", "gate-user-a")))
            AssertDenied(await GateHom.RunMiddlewareAsync(restricted, requirement, stranger), "com entrada");
        using var removed = GateHom.Host(new Dictionary<string, string?>());
        AssertAllowed(await GateHom.RunMiddlewareAsync(removed, requirement, stranger), "sem entrada");
        Assert.Equal(0, removed.Probe.Calls);
    }
}
