// Gate FC-017-AVALIACAO (template). Avaliador único com a chave da funcionalidade como parâmetro (creator, billing, gate-feature):
// Parse, regra 1 (uid ordinal ou e-mail verificado sem caixa), regra 2 (dono só por uid, válvula, vínculo ativo), economia de
// consulta ao probe e propagação de falha. Sem PostgreSQL, sem HTTP. Valores sintéticos.
namespace Fluxo.Api.Tests;

public sealed class GateFc017EvaluatorTests
{
    private static HomHost Gate(string uids = "", string emails = "", string businesses = "", string feature = "gate-feature") =>
        GateHom.Host(GateHom.Lists3(feature, uids, emails, businesses));

    [Fact]
    public void Parse_handles_separators_blanks_duplicates_case_and_empty_inputs()
    {
        Assert.Equal(["a", "b", "c", "d"], GateHom.Parse("a,b;c  d").Order(StringComparer.Ordinal).ToArray());
        Assert.Equal(["a", "b", "c"], GateHom.Parse("a\tb\nc").Order(StringComparer.Ordinal).ToArray());
        Assert.Equal(["a", "b"], GateHom.Parse(" a ,, b ;; a ").Order(StringComparer.Ordinal).ToArray());
        Assert.Equal(["Gate-User-A", "gate-user-a"], GateHom.Parse("Gate-User-A,gate-user-a").Order(StringComparer.Ordinal).ToArray());
        foreach (var empty in new[] { null, "", " , ;", "   ", "none" })
            Assert.True(GateHom.Parse(empty).Length == 0, $"Parse({(empty is null ? "null" : $"\"{empty}\"")}) deveria ser vazio");
        using var host = Gate(uids: "none");
        Assert.Equal("Denied", GateHom.EvalUser(host, "gate-feature", "none"));
    }

    [Fact]
    public void Without_an_entry_the_feature_is_unrestricted_and_open_mode_is_open_and_keys_ignore_case()
    {
        using var host = GateHom.Host(GateHom.Merge(GateHom.Lists3("billing", "gate-user-a"), GateHom.Lists3("gate-open", mode: "Open")));
        foreach (var key in new[] { "gate-feature", "GATE-FEATURE", "creator" })
        {
            Assert.Equal("Unrestricted", GateHom.EvalUser(host, key, "gate-user-z"));
            Assert.Equal("Unrestricted", GateHom.EvalUser(host, key, null));
            Assert.Equal("Unrestricted", GateHom.EvalAsync(host, key, GateHom.User("gate-user-z"), "gate-biz-a").GetAwaiter().GetResult());
        }
        Assert.Equal("Open", GateHom.EvalUser(host, "gate-open", "gate-user-z"));
        Assert.Equal("Open", GateHom.EvalUser(host, "GATE-OPEN", null));
        Assert.Equal("Open", GateHom.EvalAsync(host, "gate-open", GateHom.User("gate-user-z"), null).GetAwaiter().GetResult());
        Assert.Equal("ViaUser", GateHom.EvalUser(host, "BILLING", "gate-user-a"));
        Assert.Equal("ViaUser", GateHom.EvalUser(host, "Billing", "gate-user-a"));
        Assert.Equal(0, host.Probe.Calls);
    }

    [Fact]
    public void Rule_one_authorizes_by_uid_ordinal_or_verified_email_without_case_and_never_by_unverified_email()
    {
        using var host = Gate(uids: "gate-user-a; Gate-User-B  gate-user-c,,", emails: "Gate-Mail-A@example.test,gatemail@example.test");
        foreach (var feature in new[] { "gate-feature", "GATE-Feature" })
        {
            Assert.Equal("ViaUser", GateHom.EvalUser(host, feature, "gate-user-a"));
            Assert.Equal("ViaUser", GateHom.EvalUser(host, feature, "Gate-User-B"));
            Assert.Equal("ViaUser", GateHom.EvalUser(host, feature, "gate-user-c"));
            Assert.Equal("Denied", GateHom.EvalUser(host, feature, "GATE-USER-A"));
            Assert.Equal("Denied", GateHom.EvalUser(host, feature, "gate-user-b"));
            Assert.Equal("Denied", GateHom.EvalUser(host, feature, "gate-user-a-extra"));
            Assert.Equal("Denied", GateHom.EvalUser(host, feature, null));
            Assert.Equal("ViaUser", GateHom.EvalUser(host, feature, "gate-user-z", "gate-mail-a@EXAMPLE.test", verified: true));
            Assert.Equal("ViaUser", GateHom.EvalUser(host, feature, "gate-user-z", "GATE-MAIL-A@example.test", verified: true));
            Assert.Equal("Denied", GateHom.EvalUser(host, feature, "gate-user-z", "gate-mail-a@example.test", verified: false));
            Assert.Equal("Denied", GateHom.EvalUser(host, feature, "gate-user-z", null, verified: true));
            Assert.Equal("Denied", GateHom.EvalUser(host, feature, null, "gate-mail-a@example.test", verified: false));
            Assert.Equal("ViaUser", GateHom.EvalUser(host, feature, "gate-user-a", null, verified: false));
            Assert.Equal("ViaUser", GateHom.EvalUser(host, feature, "gate-user-a", "outro@example.test", verified: false));
            // Sem canonicalização de provedor: pontos e +tag não são normalizados.
            Assert.Equal("Denied", GateHom.EvalUser(host, feature, "gate-user-z", "gate.mail@example.test", verified: true));
            Assert.Equal("Denied", GateHom.EvalUser(host, feature, "gate-user-z", "gatemail+tag@example.test", verified: true));
            Assert.Equal("ViaUser", GateHom.EvalUser(host, feature, "gate-user-z", "gatemail@example.test", verified: true));
        }
        Assert.Equal(0, host.Probe.Calls);
    }

    [Fact]
    public void Features_are_isolated_from_each_other()
    {
        using var host = GateHom.Host(GateHom.Merge(GateHom.Lists3("creator", "gate-user-a"), GateHom.Lists3("billing", "gate-user-b", "gate-mail-b@example.test")));
        Assert.Equal("ViaUser", GateHom.EvalUser(host, "creator", "gate-user-a"));
        Assert.Equal("Denied", GateHom.EvalUser(host, "creator", "gate-user-b"));
        Assert.Equal("Denied", GateHom.EvalUser(host, "creator", "gate-user-z", "gate-mail-b@example.test", verified: true));
        Assert.Equal("ViaUser", GateHom.EvalUser(host, "billing", "gate-user-b"));
        Assert.Equal("Denied", GateHom.EvalUser(host, "billing", "gate-user-a"));
        Assert.Equal("Unrestricted", GateHom.EvalUser(host, "gate-feature", "gate-user-a"));
        host.Probe.Member = (_, _) => true;
        var member = GateHom.User("gate-user-m");
        // Isolamento na regra 2: o dono listado só em billing libera billing (ViaOwner, spec regra 2) e NÃO libera creator; e vice-versa.
        // Um dono fora das duas listas não libera nenhuma.
        host.Probe.Owners = _ => ["gate-user-b"];
        Assert.Equal("Denied", GateHom.EvalAsync(host, "creator", member, "gate-biz-a").GetAwaiter().GetResult());
        Assert.Equal("ViaOwner", GateHom.EvalAsync(host, "billing", member, "gate-biz-a").GetAwaiter().GetResult());
        host.Probe.Owners = _ => ["gate-user-a"];
        Assert.Equal("ViaOwner", GateHom.EvalAsync(host, "creator", member, "gate-biz-a").GetAwaiter().GetResult());
        Assert.Equal("Denied", GateHom.EvalAsync(host, "billing", member, "gate-biz-a").GetAwaiter().GetResult());
        host.Probe.Owners = _ => ["gate-user-z"];
        Assert.Equal("Denied", GateHom.EvalAsync(host, "creator", member, "gate-biz-a").GetAwaiter().GetResult());
        Assert.Equal("Denied", GateHom.EvalAsync(host, "billing", member, "gate-biz-a").GetAwaiter().GetResult());
    }

    [Fact]
    public async Task Account_is_authorized_by_the_owner_uid_or_the_business_list_and_only_with_an_active_link()
    {
        using var host = Gate(uids: "gate-user-a", businesses: "gate-biz-v");
        var probe = host.Probe;
        var member = GateHom.User("gate-user-m", "gate-mail-m@example.test", verified: true);

        probe.Member = (_, _) => true;
        probe.Owners = _ => ["gate-user-a"];
        Assert.Equal("ViaOwner", await GateHom.EvalAsync(host, "gate-feature", member, "gate-biz-1"));
        Assert.True(probe.MemberCalls >= 1 && probe.OwnerCalls >= 1, "ViaOwner exige consultar vínculo e donos");

        probe.Member = (_, _) => false;
        Assert.Equal("Denied", await GateHom.EvalAsync(host, "gate-feature", member, "gate-biz-1"));

        probe.Member = (_, _) => true;
        probe.Owners = _ => ["GATE-USER-A"];
        Assert.Equal("Denied", await GateHom.EvalAsync(host, "gate-feature", member, "gate-biz-1"));
        probe.Owners = _ => ["gate-user-x"];
        Assert.Equal("Denied", await GateHom.EvalAsync(host, "gate-feature", member, "gate-biz-1"));
        probe.Owners = _ => Array.Empty<string>();
        Assert.Equal("Denied", await GateHom.EvalAsync(host, "gate-feature", member, "gate-biz-1"));
        probe.Owners = _ => ["gate-user-x", "gate-user-a"];
        Assert.Equal("ViaOwner", await GateHom.EvalAsync(host, "gate-feature", member, "gate-biz-1"));

        probe.Owners = _ => Array.Empty<string>();
        Assert.Equal("ViaBusinessList", await GateHom.EvalAsync(host, "gate-feature", member, "gate-biz-v"));
        Assert.Equal("Denied", await GateHom.EvalAsync(host, "gate-feature", member, "GATE-BIZ-V"));
        probe.Member = (_, _) => false;
        Assert.Equal("Denied", await GateHom.EvalAsync(host, "gate-feature", member, "gate-biz-v"));

        // Rule 1 sempre vence, sem consultar o probe.
        var before = probe.Calls;
        Assert.Equal("ViaUser", await GateHom.EvalAsync(host, "gate-feature", GateHom.User("gate-user-a"), "gate-biz-1"));
        Assert.Equal(before, probe.Calls);

        // Sem businessId só vale a regra 1 e o probe não é tocado.
        Assert.Equal("Denied", await GateHom.EvalAsync(host, "gate-feature", member, null));
        Assert.Equal(before, probe.Calls);
    }

    [Fact]
    public async Task The_probe_is_not_touched_when_there_is_no_list_to_consult_and_owners_never_match_by_email()
    {
        using var onlyEmails = Gate(emails: "gate-mail-a@example.test");
        onlyEmails.Probe.Member = (_, _) => true;
        onlyEmails.Probe.Owners = _ => ["gate-mail-a@example.test", "gate-user-a"];
        var member = GateHom.User("gate-user-m", "gate-mail-m@example.test", verified: true);
        Assert.Equal("Denied", await GateHom.EvalAsync(onlyEmails, "gate-feature", member, "gate-biz-1"));
        Assert.Equal(0, onlyEmails.Probe.Calls);

        using var closed = Gate();
        closed.Probe.Member = (_, _) => true;
        closed.Probe.Owners = _ => ["gate-user-a"];
        Assert.Equal("Denied", await GateHom.EvalAsync(closed, "gate-feature", GateHom.User("gate-user-a", "gate-mail-a@example.test", verified: true), "gate-biz-1"));
        Assert.Equal("Denied", GateHom.EvalUser(closed, "gate-feature", "gate-user-a"));
        Assert.Equal(0, closed.Probe.Calls);

        // O dono herdeiro vale só por uid: lista só de e-mails não faz a conta herdar, mesmo com o e-mail do dono igual.
        using var uidsAndEmails = Gate(uids: "gate-user-q", emails: "gate-mail-a@example.test");
        uidsAndEmails.Probe.Member = (_, _) => true;
        uidsAndEmails.Probe.Owners = _ => ["gate-mail-a@example.test"];
        Assert.Equal("Denied", await GateHom.EvalAsync(uidsAndEmails, "gate-feature", member, "gate-biz-1"));
    }

    [Fact]
    public async Task Probe_failures_propagate_and_never_become_a_release()
    {
        using var host = Gate(uids: "gate-user-a", businesses: "gate-biz-v");
        var member = GateHom.User("gate-user-m");
        host.Probe.MemberFails = new InvalidOperationException("gate-boom-member");
        var first = await Assert.ThrowsAnyAsync<Exception>(() => GateHom.EvalAsync(host, "gate-feature", member, "gate-biz-1"));
        Assert.Contains("gate-boom-member", first.ToString());
        Assert.Contains("gate-boom-member", (await Assert.ThrowsAnyAsync<Exception>(() => GateHom.EvalAsync(host, "gate-feature", member, "gate-biz-v"))).ToString());

        host.Probe.MemberFails = null;
        host.Probe.Member = (_, _) => true;
        host.Probe.OwnersFails = new InvalidOperationException("gate-boom-owners");
        var second = await Assert.ThrowsAnyAsync<Exception>(() => GateHom.EvalAsync(host, "gate-feature", member, "gate-biz-1"));
        Assert.Contains("gate-boom-owners", second.ToString());

        // Sem cache de "liberado": a mesma chamada reavalia e reflete a mudança na hora.
        host.Probe.OwnersFails = null;
        host.Probe.Owners = _ => ["gate-user-a"];
        Assert.Equal("ViaOwner", await GateHom.EvalAsync(host, "gate-feature", member, "gate-biz-1"));
        host.Probe.Owners = _ => ["gate-user-x"];
        Assert.Equal("Denied", await GateHom.EvalAsync(host, "gate-feature", member, "gate-biz-1"));
        host.Probe.Owners = _ => ["gate-user-a"];
        host.Probe.Member = (_, _) => false;
        Assert.Equal("Denied", await GateHom.EvalAsync(host, "gate-feature", member, "gate-biz-1"));
    }
}
