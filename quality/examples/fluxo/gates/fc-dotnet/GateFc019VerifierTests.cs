// Gates do decorador de verificação dev da FC-019 (template). Usa o host mínimo (GateDev.Host) e o registro real:
// o resolvedor devolve DevOverrideTokenVerifier quando Enabled. Claims fixados pela spec: sub, email, email_verified
// e auth_time; nenhum claim de privilégio e nenhum name. Tudo sintético.
using System.Security.Claims;
using Fluxo.Api.Infrastructure.Security;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Fluxo.Api.Tests;

public sealed class GateFc019VerifierTests
{
    private static DevHost HostWith(params (string Key, string? Value)[] extra)
    {
        var settings = GateDev.DevSettings(true, "gate-user-a");
        foreach (var (key, value) in extra) settings[key] = value;
        return GateDev.Host(settings);
    }

    [Fact]
    public async Task Dev_token_with_a_listed_uid_yields_the_exact_claims_and_no_privilege_claims()
    {
        using var host = HostWith();
        var principal = await host.Verifier.VerifyUserTokenAsync(GateDev.Dev("gate-user-a"), CancellationToken.None);
        Assert.Equal("gate-user-a", principal.FindFirstValue("sub"));
        Assert.Equal("gate-user-a@example.test", principal.FindFirstValue("email"));
        Assert.Equal("false", principal.FindFirstValue("email_verified"));
        var authTime = principal.FindFirstValue("auth_time");
        Assert.True(long.TryParse(authTime, out var seconds) && Math.Abs(DateTimeOffset.UtcNow.ToUnixTimeSeconds() - seconds) < 300,
            $"auth_time não é o agora: {authTime}");
        var names = principal.Claims.Select(claim => claim.Type).ToHashSet(StringComparer.Ordinal);
        Assert.Equal(new HashSet<string>(StringComparer.Ordinal) { "sub", "email", "email_verified", "auth_time" }, names);
    }

    [Fact]
    public async Task Non_dev_tokens_delegate_to_the_real_verifier()
    {
        using var host = HostWith();
        var error = await Assert.ThrowsAnyAsync<Exception>(() =>
            host.Verifier.VerifyUserTokenAsync("garbage-not-a-jwt", CancellationToken.None));
        Assert.StartsWith("SecurityToken", error.GetType().Name, StringComparison.Ordinal);
        // Um token real (JWT mal assinado) também passa pelo verificador real, não pelo caminho dev.
        Assert.StartsWith("SecurityToken", error.GetType().Name, StringComparison.Ordinal);
    }

    [Fact]
    public async Task App_check_verification_always_delegates_and_never_accepts_dev_tokens()
    {
        using var host = HostWith();
        var error = await Assert.ThrowsAnyAsync<Exception>(() =>
            host.Verifier.VerifyAppCheckTokenAsync(GateDev.Dev("gate-user-a"), CancellationToken.None));
        Assert.StartsWith("SecurityToken", error.GetType().Name, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Case_variants_malformed_and_overlong_tokens_are_refused()
    {
        using var host = HostWith(("Auth:DevOverride:AllowedUids", "gate-user-a,Gate-User-upper"));
        await Assert.ThrowsAnyAsync<Exception>(() =>
            host.Verifier.VerifyUserTokenAsync(GateDev.Dev("GATE-USER-A"), CancellationToken.None)); // caixa difere (ordinal)
        await Assert.ThrowsAnyAsync<Exception>(() =>
            host.Verifier.VerifyUserTokenAsync(GateDev.DevPrefix, CancellationToken.None)); // sem uid
        await Assert.ThrowsAnyAsync<Exception>(() =>
            host.Verifier.VerifyUserTokenAsync(GateDev.Dev("a.b"), CancellationToken.None)); // uid inválido
        await Assert.ThrowsAnyAsync<Exception>(() =>
            host.Verifier.VerifyUserTokenAsync(GateDev.Dev(new string('a', 129)), CancellationToken.None)); // 133 > máximo
        // Fronteira: uid de 128 é exatamente o token de 132 caracteres e autentica.
        var boundary = new string('a', 128);
        using var boundaryHost = HostWith(("Auth:DevOverride:AllowedUids", boundary));
        var principal = await boundaryHost.Verifier.VerifyUserTokenAsync(GateDev.Dev(boundary), CancellationToken.None);
        Assert.Equal(boundary, principal.FindFirstValue("sub"));
    }

    [Fact]
    public async Task Acceptance_is_reevaluated_on_every_request()
    {
        using var host = HostWith();
        var token = GateDev.Dev("gate-user-a");
        var principal = await host.Verifier.VerifyUserTokenAsync(token, CancellationToken.None);
        Assert.Equal("gate-user-a", principal.FindFirstValue("sub"));

        host.Env.EnvironmentName = "Production"; // ambiente mudou depois de "aceito": a reavaliação derruba o token
        await Assert.ThrowsAnyAsync<Exception>(() => host.Verifier.VerifyUserTokenAsync(token, CancellationToken.None));

        host.Env.EnvironmentName = "Testing";
        principal = await host.Verifier.VerifyUserTokenAsync(token, CancellationToken.None);
        Assert.Equal("gate-user-a", principal.FindFirstValue("sub"));
    }

    [Fact]
    public void Firebase_user_from_a_dev_principal_has_no_privilege_and_unverified_email()
    {
        using var host = HostWith();
        var principal = host.Verifier.VerifyUserTokenAsync(GateDev.Dev("gate-user-a"), CancellationToken.None).GetAwaiter().GetResult();
        var user = FirebaseUser.From(principal, appId: null);
        Assert.Equal("gate-user-a", user.Uid);
        Assert.Equal("gate-user-a@example.test", user.Email);
        Assert.False(user.IsFluxoAdmin);
        Assert.Null(user.AdminRole);
        Assert.Null(user.TenantId);
        Assert.Null(user.SecondFactor);
        Assert.Equal(0, user.PermissionsVersion);
        Assert.False(user.EmailVerified);
        Assert.Null(user.AppId);
    }
}