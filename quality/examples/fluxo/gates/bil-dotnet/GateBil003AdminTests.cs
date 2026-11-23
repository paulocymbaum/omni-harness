// Gate BIL-003-DOTNET-TESTES. Template do autor de gates. Autorização e plano manual por HTTP, auditoria por SQL.
using System.Net;
using Fluxo.Api.Infrastructure.Security;
using Fluxo.Api.Modules.Admin;

namespace Fluxo.Api.Tests;

public sealed class GateBil003AdminTests
{
    private const string Tenant = "fluxo-admin-c38u7";
    private const string Reason = "Cortesia do piloto com a empresa";

    private static string Subject(string id) => $"/api/v1/admin/billing/subjects/business/{id}";

    private static (DebateApiFactory Factory, HttpClient Client) Admin(string role, params string[] permissions)
    {
        var factory = new DebateApiFactory(GateBil.C, settings: GateBil.Settings());
        var uid = $"admin-{Guid.NewGuid():N}";
        factory.Registry.Grant(uid, role, permissions);
        return (factory, factory.Client(DebateApiFactory.Admin(uid, role)));
    }

    private static bool Authorized(string role, string needed, params string[] granted)
    {
        var user = new FirebaseUser("u1", "u1@example.test", null, null, null, true, role, Tenant, "totp", 1, DateTimeOffset.UtcNow);
        var access = new Dictionary<string, object>
        {
            ["tenantId"] = Tenant, ["email"] = "u1@example.test", ["status"] = "active", ["role"] = role,
            ["permissionsVersion"] = 1L, ["permissions"] = granted.Cast<object>().ToList(),
        };
        return AdminAccessRegistry.IsAuthorized(user, access, needed, Tenant);
    }

    private static Task<long> AuditRowsAsync(string action) => DebateTestDb.ScalarAsync<long>(GateBil.C,
        $"SELECT count(*) FROM fluxo.billing_audit_events e WHERE to_jsonb(e)::text LIKE '%{action}%'");

    [Fact]
    public void Billing_read_is_implied_by_manage_and_refund_and_denied_to_legal()
    {
        Assert.True(Authorized("admin", "billing.read", "billing.manage"));
        Assert.True(Authorized("admin", "billing.read", "billing.refund"));
        Assert.False(Authorized("admin", "billing.manage", "billing.read"));
        Assert.False(Authorized("admin", "billing.refund", "billing.manage"));
        Assert.False(Authorized("legal", "billing.read", "billing.read", "billing.manage", "billing.refund"));
    }

    [Theory]
    [InlineData("reports.read", "reports.decide")]
    [InlineData("users.read", "people.verify")]
    [InlineData("events.read", "events.moderate")]
    [InlineData("debates.review", "debates.publish")]
    public void Previous_implications_stay_the_same(string read, string write) => Assert.True(Authorized("admin", read, write));

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Manual_plan_routes_enforce_permissions_and_recent_auth()
    {
        var (id, _) = await GateBil.SeedBusinessAsync();
        await GateBil.ApplyMvpAsync();
        var (factory, reader) = Admin("admin", "billing.read");
        await using var _f = factory;
        using (var allowed = await reader.GetAsync(Subject(id))) Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
        using (var denied = await DebateApiFactory.SendAsync(reader, HttpMethod.Post, $"{Subject(id)}/manual-plan", new { productCode = "local", reason = Reason }))
        {
            Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
            Assert.Equal("admin_access_denied", await DebateApiFactory.CodeAsync(denied));
        }
        var uid = $"stale-{Guid.NewGuid():N}";
        factory.Registry.Grant(uid, "admin", "billing.manage");
        using var stale = factory.Client(DebateApiFactory.Admin(uid, authAgeSeconds: 7200));
        using var response = await DebateApiFactory.SendAsync(stale, HttpMethod.Post, $"{Subject(id)}/manual-plan", new { productCode = "local", reason = Reason });
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal("reauth_required", await DebateApiFactory.CodeAsync(response));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Short_reason_is_refused_without_audit_or_subscription()
    {
        var (id, _) = await GateBil.SeedBusinessAsync();
        await GateBil.ApplyMvpAsync();
        var (factory, client) = Admin("admin", "billing.manage");
        await using var _f = factory;
        using var response = await DebateApiFactory.SendAsync(client, HttpMethod.Post, $"{Subject(id)}/manual-plan", new { productCode = "local", reason = "curto" });
        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        Assert.Equal(0L, await AuditRowsAsync(id));
        Assert.Equal(0L, await DebateTestDb.ScalarAsync<long>(GateBil.C, $"SELECT count(*) FROM fluxo.billing_customers WHERE subject_id='{id}'"));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Manual_plan_activates_inactive_product_audits_and_can_be_canceled()
    {
        var (id, owner) = await GateBil.SeedBusinessAsync();
        await GateBil.ApplyMvpAsync();
        var (factory, client) = Admin("admin", "billing.manage");
        await using var _f = factory;
        using (var created = await DebateApiFactory.SendAsync(client, HttpMethod.Post, $"{Subject(id)}/manual-plan", new { productCode = "local", reason = Reason }))
        {
            var text = await created.Content.ReadAsStringAsync();
            Assert.True(created.IsSuccessStatusCode, $"HTTP {(int)created.StatusCode}: {text}");
            Assert.DoesNotContain("tax_id", text, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("taxId", text, StringComparison.OrdinalIgnoreCase);
        }
        var row = await DebateTestDb.ScalarAsync<string>(GateBil.C, $"""
            SELECT to_jsonb(s)::text FROM fluxo.billing_subscriptions s JOIN fluxo.billing_customers c ON c.id=s.customer_id WHERE c.subject_id='{id}'
            """);
        Assert.Contains("\"rail\": \"manual\"", row);
        Assert.Contains("\"status\": \"active\"", row);
        Assert.Equal(0L, await DebateTestDb.ScalarAsync<long>(GateBil.C,
            $"SELECT count(*) FROM fluxo.billing_invoices i WHERE to_jsonb(i)::text LIKE '%{id}%'"));

        var audit = Assert.Single(await GateBil.RowsAsync(GateBil.C, $"SELECT to_jsonb(e)::text FROM fluxo.billing_audit_events e WHERE to_jsonb(e)::text LIKE '%{id}%'"));
        foreach (var field in new[] { "actor_uid", "action", "before", "after", "reason", "correlation_id" }) Assert.Contains($"\"{field}\"", audit);
        Assert.Contains(Reason, audit);

        using (var duplicate = await DebateApiFactory.SendAsync(client, HttpMethod.Post, $"{Subject(id)}/manual-plan", new { productCode = "pro", reason = Reason }))
        {
            Assert.Equal(HttpStatusCode.Conflict, duplicate.StatusCode);
            Assert.Equal("billing_subscription_exists", await DebateApiFactory.CodeAsync(duplicate));
        }

        using var ownerClient = factory.Client($"user:{owner}");
        using (var plan = await ownerClient.GetAsync($"/api/v1/billing/subjects/business/{id}/entitlements"))
        {
            var body = await GateBil.JsonAsync(plan);
            Assert.Equal("local", body.GetProperty("planCode").GetString());
            Assert.Equal("subscription", body.GetProperty("source").GetString());
        }
        using (var subscription = await ownerClient.GetAsync($"/api/v1/billing/subjects/business/{id}/subscription"))
            Assert.Contains("active", GateBil.Strings(await GateBil.JsonAsync(subscription)));

        var subscriptionId = await DebateTestDb.ScalarAsync<Guid>(GateBil.C,
            $"SELECT s.id FROM fluxo.billing_subscriptions s JOIN fluxo.billing_customers c ON c.id=s.customer_id WHERE c.subject_id='{id}'");
        using (var canceled = await DebateApiFactory.SendAsync(client, HttpMethod.Post, $"/api/v1/admin/billing/subscriptions/{subscriptionId}/cancel", new { reason = Reason }))
            Assert.True(canceled.IsSuccessStatusCode, await canceled.Content.ReadAsStringAsync());
        using (var after = await ownerClient.GetAsync($"/api/v1/billing/subjects/business/{id}/entitlements"))
            Assert.Equal("presenca", (await GateBil.JsonAsync(after)).GetProperty("planCode").GetString());
        Assert.Equal(2L, await AuditRowsAsync(id));
    }
}
