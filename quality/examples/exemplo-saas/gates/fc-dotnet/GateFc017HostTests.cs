// Gates FC-017-FALHA-NUNCA-LIBERA e FC-017-SEM-PII-LOG (template). API completa com PostgreSQL; a sonda de vínculo/donos é trocada por
// uma falsa (FALHA) ou fica a real (LOG). Log capturado em memória por um ILoggerProvider injetado na API. Valores sintéticos.
// Rota-sonda de FALHA: /geo/ufs?businessId=<id>, cujo handler não consulta vínculo: 200 só pode vir da porta de homologação.
using System.Text.RegularExpressions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;

namespace Fluxo.Api.Tests;

public sealed class GateFc017HostTests
{
    private static Action<IServiceCollection> UseProbe(HomProbe probe) => services =>
    {
        var iface = GateFc.Find("IHomologacaoAccountProbe");
        services.RemoveAll(iface);
        services.AddSingleton(iface, probe);
    };

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Probe_failures_answer_5xx_never_200_and_leak_nothing()
    {
        var probe = HomProbe.Create();
        var (listed, uid, business) = (GateHom.NewUid(), GateHom.NewUid(), $"gate-biz-{Guid.NewGuid():N}");
        var boom = $"gate-boom-{Guid.NewGuid():N}";
        await using var factory = GateHom.Api("Allowlist", new Lists(Uids: listed), UseProbe(probe));
        using var client = factory.Client($"user:{uid}");

        probe.MemberFails = new InvalidOperationException(boom);
        var memberFailure = await GateFc.GetAsync(client, GateHom.Geo(business));
        probe.MemberFails = null;
        probe.Member = (_, _) => true;
        probe.OwnersFails = new InvalidOperationException(boom);
        var ownersFailure = await GateFc.GetAsync(client, GateHom.Geo(business));
        var configFailure = await GateFc.GetAsync(client, GateHom.Config(business));

        foreach (var (name, result) in new[] { ("IsActiveMemberAsync", memberFailure), ("GetOwnerUidsAsync", ownersFailure), ("/config", configFailure) })
        {
            Assert.True(result.Status is >= 500 and < 600, $"{name} falhando: esperava 5xx, veio {result.Status}");
            var text = result.Body.ValueKind == System.Text.Json.JsonValueKind.Undefined ? "" : result.Body.GetRawText();
            foreach (var secret in new[] { uid, listed, business, boom }) Assert.DoesNotContain(secret, text);
        }
        Assert.True(probe.MemberCalls >= 1 && probe.OwnerCalls >= 1, "o probe precisava ser consultado nos dois ramos");
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task A_release_is_never_cached_between_requests()
    {
        var probe = HomProbe.Create();
        var (listed, uid, business) = (GateHom.NewUid(), GateHom.NewUid(), $"gate-biz-{Guid.NewGuid():N}");
        await using var factory = GateHom.Api("Allowlist", new Lists(Uids: listed), UseProbe(probe));
        using var client = factory.Client($"user:{uid}");
        var route = GateHom.Geo(business);

        probe.Member = (_, _) => true;
        probe.Owners = _ => [listed];
        Assert.Equal(200, await GateHom.StatusAsync(client, route));
        probe.Member = (_, _) => false;
        GateHom.AssertDisabled404(await GateFc.GetAsync(client, route), "vínculo revogado entre duas requisições");
        probe.Member = (_, _) => true;
        probe.Owners = _ => [GateHom.NewUid()];
        GateHom.AssertDisabled404(await GateFc.GetAsync(client, route), "dono trocado entre duas requisições");
        probe.Owners = _ => [listed];
        Assert.Equal(200, await GateHom.StatusAsync(client, route));
        Assert.True(probe.MemberCalls >= 4, $"cada requisição precisa reavaliar o vínculo (consultas: {probe.MemberCalls})");
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Logs_carry_only_feature_mode_and_counts_and_never_identifiers_emails_or_lists()
    {
        var logs = new HomLogs();
        var (id, owner) = await GateFc.SeedBusinessAsync();
        var member = await GateFc.SeedMemberAsync(id, "EDITOR");
        var (valveBusiness, _) = await GateFc.SeedBusinessAsync();
        var valveMember = await GateFc.SeedMemberAsync(valveBusiness, "VIEWER");
        var (listedUid, listedEmail, stranger) = (GateHom.NewUid(), GateHom.NewEmail(), GateHom.NewUid("gate-stranger"));
        var lists = new Lists($"{listedUid},{owner}", listedEmail, valveBusiness);
        await using var factory = GateHom.Api("Allowlist", lists, s => s.AddSingleton<ILoggerProvider>(logs), false,
            ("Homologacao:gate-feature:Mode", "Open"), ("Logging:LogLevel:Fluxo", "Trace"));

        using (var byUid = factory.Client($"user:{listedUid}")) Assert.Equal(200, await GateHom.StatusAsync(byUid, GateHom.Ufs));
        using (var byEmail = factory.Client(GateHom.Token(GateHom.NewUid(), listedEmail, "true"))) Assert.Equal(200, await GateHom.StatusAsync(byEmail, GateHom.Ufs));
        using (var byOwner = factory.Client($"user:{member}")) Assert.Equal(200, (await GateFc.GetAsync(byOwner, GateHom.Config(id))).Status);
        using (var byValve = factory.Client($"user:{valveMember}")) Assert.Equal(200, (await GateFc.GetAsync(byValve, GateHom.Config(valveBusiness))).Status);
        using (var denied = factory.Client($"user:{stranger}"))
        {
            GateHom.AssertDisabled404(await GateFc.GetAsync(denied, GateHom.Config(id)), "estranho /config");
            GateHom.AssertDisabled404(await GateFc.GetAsync(denied, GateHom.Ufs), "estranho /geo");
        }
        using (var unverified = factory.Client(GateHom.Token(GateHom.NewUid(), listedEmail, "false")))
            GateHom.AssertDisabled404(await GateFc.GetAsync(unverified, GateHom.Ufs), "e-mail listado não verificado");

        var all = logs.Entries.ToArray();
        Assert.NotEmpty(all);
        var relevant = all.Where(e => Regex.IsMatch(e.Category, "Homolog|MembershipProbe|ApiExceptionHandler")).ToArray();
        Assert.Empty(all.Where(e => e.Category.Contains("HomologacaoMiddleware") || e.Category.Contains("HomologacaoEvaluator")));
        var secrets = new[] { listedUid, owner, member, valveMember, valveBusiness, id, stranger, listedEmail, listedEmail.Split('@')[0], lists.Uids, lists.Emails };
        foreach (var secret in secrets)
            Assert.True(relevant.All(e => !e.Text.Contains(secret, StringComparison.OrdinalIgnoreCase)), $"log da homologação carrega um identificador: {secret[..Math.Min(12, secret.Length)]}...");
        foreach (var secret in new[] { listedEmail, listedEmail.Split('@')[0], lists.Uids, lists.Emails })
            Assert.True(all.All(e => !e.Text.Contains(secret, StringComparison.OrdinalIgnoreCase)), "e-mail ou texto das listas apareceu em algum log da API");

        var startup = relevant.Where(e => e.Category.Contains("Homologacao") && e.Level is LogLevel.Information or LogLevel.Warning).ToArray();
        var creator = startup.Where(e => e.Level == LogLevel.Information && e.Text.Contains("Creator", StringComparison.OrdinalIgnoreCase)).Select(e => e.Text).ToArray();
        Assert.True(creator.Any(t => t.Contains("Allowlist") && t.Contains("userUids=2") && t.Contains("userEmails=1") && t.Contains("businessIds=1")),
            $"log de arranque de Creator sem chave, Mode e contagens (userUids=2, userEmails=1, businessIds=1). Logs: {string.Join(" || ", startup.Select(e => e.Text))}");
        Assert.True(startup.Any(e => e.Level == LogLevel.Warning && e.Text.Contains("Billing") && e.Text.Contains("homologacao closed for everyone", StringComparison.OrdinalIgnoreCase)),
            "sem Warning de Billing fechada para todos");
        Assert.True(startup.Any(e => e.Level == LogLevel.Warning && e.Text.Contains("gate-feature") && e.Text.Contains("Open")), "sem Warning de gate-feature em Open");
        Assert.DoesNotContain(startup, e => e.Level == LogLevel.Warning && e.Text.Contains("Creator", StringComparison.OrdinalIgnoreCase) && e.Text.Contains("closed for everyone", StringComparison.OrdinalIgnoreCase));
    }
}
