// Gate FC-001-SEM-REGRESSAO-TEAM (template). Reflexão pura: RequireMemberAsync nasce público e RequireAccessAsync continua fechado.
using System.Reflection;

namespace Fluxo.Api.Tests;

public sealed class GateFc001TeamTests
{
    [Fact]
    public void RequireMemberAsync_is_public_and_RequireAccessAsync_stays_closed()
    {
        var service = GateFc.Find("BusinessTeamService");
        var access = GateFc.Find("BusinessManagerAccess");
        var member = service.GetMethod("RequireMemberAsync", BindingFlags.Public | BindingFlags.Instance);
        Assert.True(member is not null, "BusinessTeamService sem RequireMemberAsync público");
        Assert.Equal(typeof(Task<>).MakeGenericType(access), member!.ReturnType);
        Assert.Equal(["string", "FirebaseUser", "CancellationToken"],
            member.GetParameters().Select(p => p.ParameterType.Name == "String" ? "string" : p.ParameterType.Name).ToArray());
        Assert.Null(service.GetMethod("RequireAccessAsync"));
        Assert.Equal(["Uid", "Role"], access.GetConstructors().Single().GetParameters().Select(p => p.Name!).ToArray());
    }
}
