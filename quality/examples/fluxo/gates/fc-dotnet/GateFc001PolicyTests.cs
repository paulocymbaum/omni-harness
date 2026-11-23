// Gate FC-001-POLITICA-PAPEIS (template). Matriz papel x permissão da CreatorAccessPolicy, função pura, sem banco.
using System.Reflection;

namespace Fluxo.Api.Tests;

public sealed class GateFc001PolicyTests
{
    private static readonly string[] Permissions = ["creator.read", "creator.create", "creator.export", "creator.brandkit.manage"];

    // papel -> permissões concedidas (tabela do spec §2)
    private static readonly Dictionary<string, string[]> Matrix = new()
    {
        ["owner"] = ["creator.read", "creator.create", "creator.export", "creator.brandkit.manage"],
        ["admin"] = ["creator.read", "creator.create", "creator.export", "creator.brandkit.manage"],
        ["editor"] = ["creator.read", "creator.create", "creator.export"],
        ["viewer"] = ["creator.read"],
    };

    private static MethodInfo PolicyMethod(string name)
    {
        var policy = GateFc.Find("CreatorAccessPolicy");
        Assert.True(policy.IsAbstract && policy.IsSealed, "CreatorAccessPolicy deve ser classe estática");
        var method = policy.GetMethod(name, BindingFlags.Public | BindingFlags.Static);
        Assert.True(method is not null, $"CreatorAccessPolicy sem método público estático {name}");
        return method!;
    }

    [Fact]
    public void Can_follows_the_role_matrix_for_all_sixteen_cells()
    {
        var roleType = GateFc.Find("CreatorMemberRole");
        var permissionType = GateFc.Find("CreatorPermission");
        var can = PolicyMethod("Can");
        foreach (var (role, granted) in Matrix)
            foreach (var permission in Permissions)
            {
                var actual = (bool)can.Invoke(null, [GateFc.Pick(roleType, role), GateFc.Pick(permissionType, permission)])!;
                Assert.True(actual == granted.Contains(permission), $"{role} x {permission}: esperado {granted.Contains(permission)}, veio {actual}");
            }
    }

    [Fact]
    public void PermissionsFor_lists_exactly_the_granted_permissions()
    {
        var roleType = GateFc.Find("CreatorMemberRole");
        var permissionType = GateFc.Find("CreatorPermission");
        var method = PolicyMethod("PermissionsFor");
        foreach (var (role, granted) in Matrix)
        {
            var result = ((System.Collections.IEnumerable)method.Invoke(null, [GateFc.Pick(roleType, role)])!).Cast<object>().ToArray();
            var expected = granted.Select(p => GateFc.Pick(permissionType, p)).Select(v => v.ToString()).Order().ToArray();
            Assert.Equal(expected, result.Select(v => v.ToString()!).Order().ToArray());
        }
    }

    [Fact]
    public void Unknown_role_gets_no_permission()
    {
        var roleType = GateFc.Find("CreatorMemberRole");
        var permissionType = GateFc.Find("CreatorPermission");
        var unknown = Enum.ToObject(roleType, 9999);
        Assert.False(Enum.IsDefined(roleType, unknown));
        foreach (var permission in Permissions)
            Assert.False((bool)PolicyMethod("Can").Invoke(null, [unknown, GateFc.Pick(permissionType, permission)])!, permission);
        var granted = ((System.Collections.IEnumerable)PolicyMethod("PermissionsFor").Invoke(null, [unknown])!).Cast<object>();
        Assert.Empty(granted);
    }
}
