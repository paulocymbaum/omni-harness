// Gates FC-017-EMAIL-VERIFICADO (parte de FirebaseUser), FC-017-NOME-NAO-AUTORIZA (forma do HomologacaoUser) e
// FC-017-TEAM-API-ESTAVEL (template). Reflexão e claims, sem PostgreSQL e sem HTTP. Valores sintéticos.
using System.Reflection;
using System.Security.Claims;
using Fluxo.Api.Infrastructure.Security;

namespace Fluxo.Api.Tests;

public sealed class GateFc017UserTests
{
    private static FirebaseUser FromClaims(params (string Type, string Value)[] claims) =>
        FirebaseUser.From(new ClaimsPrincipal(new ClaimsIdentity(claims.Select(c => new Claim(c.Type, c.Value)), "TestFirebase")), null);

    [Fact]
    public void FirebaseUser_reads_email_verified_as_the_last_parameter_with_a_false_default()
    {
        var parameters = typeof(FirebaseUser).GetConstructors().Single().GetParameters();
        Assert.True(parameters.Any(p => p.Name == "EmailVerified"), "FirebaseUser sem o parâmetro EmailVerified");
        var last = parameters[^1];
        Assert.Equal("EmailVerified", last.Name);
        Assert.Equal(typeof(bool), last.ParameterType);
        Assert.True(last.HasDefaultValue && Equals(last.DefaultValue, false), "EmailVerified precisa ter padrão false");
        Assert.Equal("AuthTime", parameters[^2].Name);

        // Construções posicionais já existentes (4 argumentos e 11 argumentos) seguem compilando e valem como não verificadas.
        var short4 = new FirebaseUser("gate-user-a", null, "Eu", null);
        var full11 = new FirebaseUser("gate-user-a", "gate-mail-a@example.test", "Eu", "app", "password", false, null, null, null, 0, null);
        var property = typeof(FirebaseUser).GetProperty("EmailVerified");
        Assert.True(property is not null, "FirebaseUser sem a propriedade EmailVerified");
        Assert.Equal(false, property!.GetValue(short4));
        Assert.Equal(false, property.GetValue(full11));

        Assert.Equal(true, property.GetValue(FromClaims(("sub", "gate-user-a"), ("email", "gate-mail-a@example.test"), ("email_verified", "true"))));
        Assert.Equal(true, property.GetValue(FromClaims(("sub", "gate-user-a"), ("email_verified", "True"))));
        Assert.Equal(false, property.GetValue(FromClaims(("sub", "gate-user-a"), ("email", "gate-mail-a@example.test"), ("email_verified", "false"))));
        Assert.Equal(false, property.GetValue(FromClaims(("sub", "gate-user-a"), ("email", "gate-mail-a@example.test"))));
        Assert.Equal(false, property.GetValue(FromClaims(("sub", "gate-user-a"), ("email", "gate-mail-a@example.test"), ("email_verified", "1"))));
        Assert.Equal(false, property.GetValue(FromClaims(("sub", "gate-user-a"), ("email", "gate-mail-a@example.test"), ("email_verified", ""))));
    }

    [Fact]
    public void HomologacaoUser_carries_uid_email_and_verification_but_no_name()
    {
        var type = GateFc.Find("HomologacaoUser");
        Assert.Equal(["Email", "EmailVerified", "Uid"], type.GetProperties(BindingFlags.Public | BindingFlags.Instance).Select(p => p.Name).Order(StringComparer.Ordinal).ToArray());
        var ctor = type.GetConstructors().Single();
        Assert.Equal(["Uid", "Email", "EmailVerified"], ctor.GetParameters().Select(p => p.Name!).ToArray());
        Assert.Equal([typeof(string), typeof(string), typeof(bool)], ctor.GetParameters().Select(p => p.ParameterType).ToArray());
        var evaluate = GateFc.Find("HomologacaoEvaluator").GetMethod("EvaluateUser");
        Assert.True(evaluate is not null, "HomologacaoEvaluator sem EvaluateUser");
        Assert.Equal([typeof(string), type], evaluate!.GetParameters().Select(p => p.ParameterType).ToArray());
    }

    [Fact]
    public void Team_service_keeps_its_api_and_only_gains_the_public_owner_resolution()
    {
        var service = GateFc.Find("BusinessTeamService");
        var access = GateFc.Find("BusinessManagerAccess");
        Assert.Null(service.GetMethod("RequireAccessAsync"));
        foreach (var name in new[] { "RequireMemberAsync", "RequireManagerAsync" })
        {
            var method = service.GetMethod(name, BindingFlags.Public | BindingFlags.Instance);
            Assert.True(method is not null, $"BusinessTeamService sem {name} público");
            Assert.Equal(typeof(Task<>).MakeGenericType(access), method!.ReturnType);
            Assert.Equal([typeof(string), typeof(FirebaseUser), typeof(CancellationToken)], method.GetParameters().Select(p => p.ParameterType).ToArray());
        }
        var owners = service.GetMethod("GetOwnerUidsAsync", BindingFlags.Public | BindingFlags.Instance);
        Assert.True(owners is not null, "BusinessTeamService sem GetOwnerUidsAsync público (D10)");
        Assert.Equal(typeof(Task<IReadOnlyList<string>>), owners!.ReturnType);
        Assert.Equal([typeof(string), typeof(CancellationToken)], owners.GetParameters().Select(p => p.ParameterType).ToArray());
    }

    [Fact]
    public void The_probe_lives_in_fluxo_empresas_and_the_evaluator_knows_no_module()
    {
        var probeInterface = GateFc.Find("IHomologacaoAccountProbe");
        Assert.Contains("Infrastructure.Homologacao", probeInterface.Namespace);
        Assert.Equal(["GetOwnerUidsAsync", "IsActiveMemberAsync"], probeInterface.GetMethods().Select(m => m.Name).Order(StringComparer.Ordinal).ToArray());
        var implementation = GateFc.Find("BusinessTeamMembershipProbe");
        Assert.Contains("Modules.FluxoEmpresas", implementation.Namespace);
        Assert.True(probeInterface.IsAssignableFrom(implementation), "BusinessTeamMembershipProbe precisa implementar IHomologacaoAccountProbe");
        Assert.Contains("Infrastructure.Homologacao", GateFc.Find("HomologacaoEvaluator").Namespace);
        Assert.Contains("Infrastructure.Homologacao", GateFc.Find("HomologacaoMiddleware").Namespace);
        Assert.Equal(["Denied", "Open", "Unrestricted", "ViaBusinessList", "ViaOwner", "ViaUser"], Enum.GetNames(GateFc.Find("HomologacaoDecision")).Order(StringComparer.Ordinal).ToArray());
    }
}
