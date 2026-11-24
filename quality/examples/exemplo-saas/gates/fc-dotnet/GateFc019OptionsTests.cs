// Gates de opções e guarda de arranque da FC-019 (template). Tipos por reflexão (GateDev): compila antes de a
// implementação existir. Todos os valores são sintéticos; mensagens citam a chave e nunca o valor.
using Microsoft.Extensions.Options;

namespace Fluxo.Api.Tests;

public sealed class GateFc019OptionsTests
{
    private const string Key = "Auth:DevOverride";

    [Fact]
    public void Default_settings_leave_the_override_off_and_the_container_resolves_the_real_verifier()
    {
        var host = GateDev.Host(new Dictionary<string, string?> { ["Firebase:ProjectId"] = "fluxo-local" });
        using (host)
        {
            var (enabled, uids) = GateDev.ReadOptions(host);
            Assert.False(enabled, "Auth:DevOverride:Enabled precisa nascer false");
            Assert.Equal("", uids);
            Assert.Equal("FirebaseTokenVerifier", host.VerifierTypeName);
        }
    }

    [Fact]
    public void Enabled_true_boots_in_development_and_testing_and_resolves_the_decorator()
    {
        Assert.False(string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("FIRESTORE_EMULATOR_HOST")),
            "FIRESTORE_EMULATOR_HOST é obrigatório para ligar o override");
        var settings = GateDev.DevSettings(true, "gate-user-boot");
        using (var testing = GateDev.Host(settings, "Testing"))
        {
            Assert.Equal("DevOverrideTokenVerifier", testing.VerifierTypeName);
            Assert.Equal("gate-user-boot", GateDev.ReadOptions(testing).AllowedUids);
        }
        using (var development = GateDev.Host(settings, "Development"))
            Assert.Equal("DevOverrideTokenVerifier", development.VerifierTypeName);
    }

    [Fact]
    public void Enabled_true_stops_the_startup_outside_development_and_testing()
    {
        var settings = GateDev.DevSettings(true, "gate-user-env");
        foreach (var environment in new[] { "Production", "Staging", "GateUnknown" })
        {
            var error = GateDev.RejectsHost(settings, environment);
            Assert.Contains($"{Key}:Enabled", error.ToString(), StringComparison.Ordinal);
            Assert.DoesNotContain("gate-user-env", error.ToString(), StringComparison.Ordinal);
        }
    }

    [Fact]
    public void Cloud_run_indicators_stop_the_startup_even_in_development()
    {
        var settings = GateDev.DevSettings(true, "gate-user-run");
        foreach (var indicator in new[] { "K_SERVICE", "K_REVISION" })
        {
            Environment.SetEnvironmentVariable(indicator, "gate-run");
            try
            {
                var error = GateDev.RejectsHost(settings, "Development");
                Assert.Contains($"{Key}:Enabled", error.ToString(), StringComparison.Ordinal);
            }
            finally { Environment.SetEnvironmentVariable(indicator, null); }
        }
    }

    [Fact]
    public void Empty_list_invalid_entries_and_missing_emulator_stop_the_startup_citing_the_key_never_the_value()
    {
        // Lista vazia com Enabled=true.
        var empty = GateDev.RejectsHost(GateDev.DevSettings(true, ""), "Testing");
        Assert.Contains($"{Key}:AllowedUids", empty.ToString(), StringComparison.Ordinal);

        // Entradas inválidas: `/`, `.` e 129 caracteres; a mensagem cita chave e índice, nunca o uid.
        var longUid = new string('a', 129);
        var invalid = GateDev.RejectsHost(GateDev.DevSettings(true, "gate/ok,ga.te,gate ok,ok;gate,ok2"), "Testing");
        Assert.Contains($"{Key}:AllowedUids contains an invalid entry", invalid.ToString(), StringComparison.Ordinal);
        var many = GateDev.RejectsHost(GateDev.DevSettings(true, $"ok1,{longUid}"), "Testing");
        Assert.Contains("(entry 2)", many.ToString(), StringComparison.Ordinal);

        // Emulador ausente: com o override ligado, o Firestore sempre é o emulador.
        var previous = Environment.GetEnvironmentVariable("FIRESTORE_EMULATOR_HOST");
        try
        {
            Environment.SetEnvironmentVariable("FIRESTORE_EMULATOR_HOST", null);
            var noEmulator = GateDev.RejectsHost(GateDev.DevSettings(true, "gate-user-emulator"), "Testing");
            Assert.Contains($"{Key} requires FIRESTORE_EMULATOR_HOST", noEmulator.ToString(), StringComparison.Ordinal);
        }
        finally { Environment.SetEnvironmentVariable("FIRESTORE_EMULATOR_HOST", previous); }
    }

    [Fact]
    public void Csv_rules_follow_the_homologacao_contract_with_a_stricter_uid_regex()
    {
        Assert.Equal(Array.Empty<string>(), GateDev.Parse(""));
        Assert.Equal(Array.Empty<string>(), GateDev.Parse("   "));
        Assert.Equal(["a", "b", "c", "d"], GateDev.Parse("a,b; c   d"));
        Assert.Equal(["a", "b"], GateDev.Parse("a,b,a")); // duplicatas colapsam, preservando a primeira
        Assert.Equal(["Gate-User"], GateDev.Parse("Gate-User")); // caixa preservada

        // O uid vira parte de um token em texto: sem `.`, `/`, espaço ou controle; 128 cabe, 129 não.
        Assert.True(GateDev.IsValidUid("gate-user_A-9"));
        Assert.True(GateDev.IsValidUid(new string('a', 128)));
        Assert.False(GateDev.IsValidUid(""));
        Assert.False(GateDev.IsValidUid("ga.te"));
        Assert.False(GateDev.IsValidUid("ga/te"));
        Assert.False(GateDev.IsValidUid("ga te"));
        Assert.False(GateDev.IsValidUid(new string('a', 129)));
        Assert.False(GateDev.IsValidUid("gate\u0007control"));
    }
}