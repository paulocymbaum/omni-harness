// Gates FC-017-OPCOES, FC-017-ENTRADA-OBRIGATORIA e (parte) FC-017-BILLING-CONFIG (template). Sem PostgreSQL: contêiner mínimo com
// AddHomologacao e IStartupValidator (o mesmo ValidateOnStart da subida), mais uma subida real da API para provar a ligação.
// Valores 100% sintéticos. Regra: mensagens citam a CHAVE e o índice da entrada (1 em diante), nunca o valor.
using Microsoft.Extensions.Configuration;

namespace Fluxo.Api.Tests;

public sealed class GateFc017OptionsTests
{
    // (chave, valor inválido, texto cru que não pode aparecer em lugar nenhum da exceção; vazio = não conferir)
    private static (string Key, string Value, string Raw)[] InvalidCases() =>
    [
        ("Mode", "gate-bad-mode-zz", "gate-bad-mode-zz"),
        ("AllowedUserUids", "gate-user-a,gate/user", "gate/user"),
        ("AllowedUserUids", "gate-user-a;gate\u0007ctl", "gate\u0007ctl"),
        ("AllowedUserUids", "gate-user-a gate-user-b ..", ""),
        ("AllowedUserUids", ".", ""),
        ("AllowedUserUids", new string('u', 129), new string('u', 129)),
        ("AllowedBusinessIds", "gate-biz-a,gate/biz", "gate/biz"),
        ("AllowedBusinessIds", new string('b', 129), new string('b', 129)),
        ("AllowedUserEmails", "gate-user-a@example.test,gate-no-at-sign", "gate-no-at-sign"),
        ("AllowedUserEmails", new string('e', 320) + "@example.test", new string('e', 320)),
    ];

    private static string AssertRejected(string feature, string key, string value, string raw, string environment = "Testing")
    {
        var error = GateHom.RejectsHost(GateHom.Entry(feature, key, value), new HostSpec(environment));
        var text = error.ToString();
        Assert.Contains($"Homologacao:{feature}:{key}", text);
        if (raw.Length >= 6) Assert.DoesNotContain(raw, text);
        if (key != "Mode") Assert.Contains("(entry ", text);
        return text;
    }

    [Fact]
    public void Invalid_entries_stop_the_startup_citing_the_key_and_never_the_value()
    {
        foreach (var feature in GateHom.Features)
            foreach (var (key, value, raw) in InvalidCases())
            {
                try { AssertRejected(feature, key, value, raw); }
                catch (Xunit.Sdk.XunitException error) { throw new Xunit.Sdk.XunitException($"{feature}:{key}: {error.Message}"); }
            }
        var emails = AssertRejected("Creator", "AllowedUserEmails", "gate-user-a@example.test,gate-no-at-sign", "gate-no-at-sign");
        Assert.Contains("Homologacao:Creator:AllowedUserEmails contains an invalid entry (entry 2).", emails);
        foreach (var key in new[] { "1-bad-key", "bad key" })
        {
            var error = GateHom.RejectsHost(GateHom.Entry(key, "AllowedUserUids", "gate-user-a"));
            Assert.Contains("Homologacao", error.ToString());
        }
        foreach (var valid in new[] { "gate-feature", "Gate_Feature2", "x" })
        {
            using var host = GateHom.Host(GateHom.Entry(valid, "AllowedUserUids", "gate-user-a"));
            Assert.Equal("ViaUser", GateHom.EvalUser(host, valid, "gate-user-a"));
        }
    }

    [Fact]
    public void Open_is_refused_outside_Development_and_Testing_and_allowed_inside()
    {
        foreach (var environment in new[] { "Production", "Staging" })
            foreach (var feature in GateHom.Features)
                foreach (var mode in new[] { "Open", "open" })
                {
                    var error = GateHom.RejectsHost(GateHom.Entry(feature, "Mode", mode), new HostSpec(environment));
                    Assert.Contains($"Homologacao:{feature}:Mode=Open is not allowed outside Development and Testing.", error.ToString());
                }
        foreach (var environment in new[] { "Development", "Testing" })
            foreach (var feature in GateHom.Features)
            {
                using var host = GateHom.Host(GateHom.Entry(feature, "Mode", "Open"), new HostSpec(environment));
                Assert.Equal("Open", GateHom.EvalUser(host, feature, "gate-user-a"));
            }
        foreach (var feature in GateHom.Features)
        {
            using var production = GateHom.Host(GateHom.Lists3(feature, "gate-user-a"), new HostSpec("Production"));
            Assert.Equal("ViaUser", GateHom.EvalUser(production, feature, "gate-user-a"));
            Assert.Equal("Denied", GateHom.EvalUser(production, feature, "gate-user-z"));
        }
    }

    [Fact]
    public void Invalid_entry_stops_the_real_api_startup()
    {
        using var factory = new DebateApiFactory(null, settings: GateFc.Settings(
            ("Homologacao:Creator:Mode", "Allowlist"), ("Homologacao:Creator:AllowedUserEmails", "gate-user-a@example.test,gate-no-at-sign")));
        var error = GateHom.Rejects(() => factory.CreateClient());
        Assert.Contains("Homologacao:Creator:AllowedUserEmails", error.ToString());
        Assert.DoesNotContain("gate-no-at-sign", error.ToString());
    }

    [Fact]
    public void Creator_entry_is_required_and_the_billing_entry_is_not()
    {
        var missing = GateHom.RejectsHost(new(), new HostSpec(Appsettings: AppsettingsMode.RealWithoutHomologacao, CreatorModule: true));
        Assert.Contains("Homologacao:Creator must be configured (Mode=Allowlist with empty lists closes it).", missing.ToString());

        // Só a entrada Creator (sem Billing e sem listas): sobe. Billing não é obrigatória.
        using var host = GateHom.Host(new Dictionary<string, string?> { ["Homologacao:Creator:Mode"] = "Allowlist" },
            new HostSpec(Appsettings: AppsettingsMode.RealWithoutHomologacao, CreatorModule: true));
        Assert.Equal("Unrestricted", GateHom.EvalUser(host, "billing", "gate-user-a"));
    }

    [Fact]
    public void Entry_with_only_the_mode_boots_and_stays_closed()
    {
        using var host = GateHom.Host(new Dictionary<string, string?> { ["Homologacao:Creator:Mode"] = "Allowlist" },
            new HostSpec(Appsettings: AppsettingsMode.RealWithoutHomologacao, CreatorModule: true));
        var owner = GateHom.User("gate-user-a", "gate-mail-a@example.test", verified: true);
        host.Probe.Member = (_, _) => true;
        host.Probe.Owners = _ => ["gate-user-a"];
        Assert.Equal("Denied", GateHom.EvalUser(host, "creator", "gate-user-a", "gate-mail-a@example.test", verified: true));
        Assert.Equal("Denied", GateHom.EvalAsync(host, "creator", owner, "gate-biz-a").GetAwaiter().GetResult());
        Assert.Equal(0, host.Probe.Calls);
    }

    [Fact]
    public void Billing_entry_is_validated_and_guarded_like_creator()
    {
        foreach (var (key, value, raw) in new[]
        {
            ("Mode", "gate-bad-mode-zz", "gate-bad-mode-zz"), ("AllowedUserUids", "gate-user-a,gate/user", "gate/user"),
            ("AllowedUserEmails", "gate-user-a@example.test,gate-no-at-sign", "gate-no-at-sign"), ("AllowedBusinessIds", "gate-biz-a;..;x", ""),
        })
        {
            var text = AssertRejected("Billing", key, value, raw);
            Assert.DoesNotContain("Homologacao:Creator", text);
        }
        var production = GateHom.RejectsHost(GateHom.Entry("Billing", "Mode", "Open"), new HostSpec("Production"));
        Assert.Contains("Homologacao:Billing:Mode=Open is not allowed outside Development and Testing.", production.ToString());
    }

    [Fact]
    public void Environment_variable_names_bind_to_the_homologacao_keys()
    {
        // Mapeamento `__` -> `:` do provedor de variáveis de ambiente, com valores sintéticos, restaurados no fim.
        var variables = new Dictionary<string, string>
        {
            ["Homologacao__Creator__Mode"] = "Allowlist",
            ["Homologacao__Creator__AllowedUserUids"] = "gate-user-env-c1;gate-user-env-c2",
            ["Homologacao__Creator__AllowedUserEmails"] = "gate-env-c@example.test",
            ["Homologacao__Creator__AllowedBusinessIds"] = "gate-biz-env-c",
            ["Homologacao__Billing__AllowedUserUids"] = "gate-user-env-b",
            ["Homologacao__Billing__AllowedUserEmails"] = "gate-env-b@example.test",
            ["Homologacao__Billing__AllowedBusinessIds"] = "gate-biz-env-b",
        };
        var previous = variables.Keys.Append("Homologacao__Billing__Mode").ToDictionary(k => k, Environment.GetEnvironmentVariable);
        try
        {
            foreach (var (name, value) in variables) Environment.SetEnvironmentVariable(name, value);
            Environment.SetEnvironmentVariable("Homologacao__Billing__Mode", null);
            using (var host = GateHom.Host(new(), new HostSpec(Configuration: new ConfigurationBuilder().AddEnvironmentVariables().Build())))
            {
                var member = GateHom.User("gate-user-m", "gate-m@example.test");
                host.Probe.Member = (_, _) => true;
                Assert.Equal("ViaUser", GateHom.EvalUser(host, "creator", "gate-user-env-c2"));
                Assert.Equal("ViaUser", GateHom.EvalUser(host, "creator", "gate-user-x", "Gate-Env-C@EXAMPLE.test", verified: true));
                Assert.Equal("ViaBusinessList", GateHom.EvalAsync(host, "creator", member, "gate-biz-env-c").GetAwaiter().GetResult());
                Assert.Equal("Denied", GateHom.EvalUser(host, "creator", "gate-user-env-b"));
                Assert.Equal("ViaUser", GateHom.EvalUser(host, "billing", "gate-user-env-b"));
                Assert.Equal("ViaUser", GateHom.EvalUser(host, "billing", "gate-user-x", "gate-env-b@example.test", verified: true));
                Assert.Equal("ViaBusinessList", GateHom.EvalAsync(host, "billing", member, "gate-biz-env-b").GetAwaiter().GetResult());
                Assert.Equal("Denied", GateHom.EvalUser(host, "billing", "gate-user-env-c1"));
            }
            Environment.SetEnvironmentVariable("Homologacao__Billing__Mode", "Open");
            using var open = GateHom.Host(new(), new HostSpec(Configuration: new ConfigurationBuilder().AddEnvironmentVariables().Build()));
            Assert.Equal("Open", GateHom.EvalUser(open, "billing", "gate-user-anyone"));
            Assert.Equal("Denied", GateHom.EvalUser(open, "creator", "gate-user-anyone"));
        }
        finally
        {
            foreach (var (name, value) in previous) Environment.SetEnvironmentVariable(name, value);
        }
    }
}
