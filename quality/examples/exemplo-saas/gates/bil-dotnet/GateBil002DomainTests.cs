// Gate BIL-002-DOTNET-TESTES (domínio). Template do autor de gates, lido por reflexão.
// A máquina de estados precisa expor um método público estático (status de origem, status de destino) que lance
// ApiException 409 invalid_subscription_transition para transição não permitida. A spec não fixa o nome do método.
using System.Reflection;
using Fluxo.Api.Bootstrap;

namespace Fluxo.Api.Tests;

public sealed class GateBil002DomainTests
{
    private static readonly Dictionary<string, string[]> Allowed = new()
    {
        ["incomplete"] = ["active", "trialing", "incomplete_expired", "canceled"],
        ["incomplete_expired"] = [],
        ["trialing"] = ["active", "past_due", "canceled"],
        ["active"] = ["past_due", "paused", "pending_cancellation", "canceled"],
        ["past_due"] = ["active", "canceled"],
        ["paused"] = ["active", "canceled"],
        ["pending_cancellation"] = ["active", "canceled"],
        ["canceled"] = [],
    };

    private static void AssertEnum(string name, params string[] wire) =>
        Assert.Equal(wire.Select(GateBil.Norm).Order(), Enum.GetNames(GateBil.Find(name)).Select(GateBil.Norm).Order());

    [Fact]
    public void Enums_have_exactly_the_specified_values()
    {
        AssertEnum("BillingSubscriptionStatus", [.. Allowed.Keys]);
        AssertEnum("BillingRail", "manual", "pix_manual", "pix_automatico");
        AssertEnum("BillingInvoiceStatus", "draft", "open", "paid", "void", "uncollectible", "refunded");
        AssertEnum("BillingChargeStatus", "pending", "paid", "failed", "expired", "refund_pending", "refunded", "chargeback");
        foreach (var name in new[] { "BillingProductKind", "BillingAudience" }) Assert.True(GateBil.Find(name).IsEnum);
    }

    [Fact]
    public void State_machine_allows_exactly_the_specified_transitions()
    {
        var status = GateBil.Find("BillingSubscriptionStatus");
        var machine = GateBil.Find("SubscriptionStateMachine");
        var method = machine.GetMethods(BindingFlags.Public | BindingFlags.Static).FirstOrDefault(m =>
            m.ReturnType != typeof(bool) && m.GetParameters().Select(p => p.ParameterType).SequenceEqual([status, status]));
        Assert.True(method is not null, "SubscriptionStateMachine precisa de método público estático (origem, destino) que lance na transição inválida");
        var values = Enum.GetValues(status).Cast<object>().ToDictionary(v => GateBil.Norm(v.ToString()!));
        foreach (var (from, targets) in Allowed)
        {
            foreach (var to in Allowed.Keys)
            {
                object? Call() => method!.Invoke(null, [values[GateBil.Norm(from)], values[GateBil.Norm(to)]]);
                if (targets.Contains(to)) { Call(); continue; }
                var error = Assert.Throws<ApiException>(() => { GateBil.Unwrap(() => Call() ?? "void"); });
                Assert.Equal(409, error.StatusCode);
                Assert.Equal("invalid_subscription_transition", error.Code);
            }
        }
    }

    [Fact]
    public void Subscription_status_has_no_public_setter()
    {
        var property = GateBil.Find("BillingSubscription").GetProperty("Status");
        Assert.NotNull(property);
        Assert.False(property!.SetMethod?.IsPublic ?? false, "BillingSubscription.Status não pode ter setter público");
    }

    [Fact]
    public void Gateway_port_and_stub_match_the_contract()
    {
        var port = GateBil.Find("IBillingGateway");
        Assert.NotNull(port.GetProperty("Provider"));
        foreach (var name in new[] { "EnsureCustomerAsync", "CreatePixChargeAsync", "FindChargeByReferenceAsync", "GetChargeAsync", "RefundAsync" })
            Assert.True(port.GetMethod(name) is not null, $"IBillingGateway sem {name}");
        Assert.True(port.IsAssignableFrom(GateBil.Find("StubBillingGateway")), "StubBillingGateway deve implementar IBillingGateway");
    }

    [Fact]
    public void Billing_is_off_by_default_with_the_stub_provider()
    {
        var type = GateBil.Find("BillingOptions");
        var options = Activator.CreateInstance(type)!;
        object? Value(string name) => type.GetProperty(name)!.GetValue(options);
        Assert.Equal(false, Value("Enabled"));
        Assert.Equal(false, Value("CheckoutEnabled"));
        Assert.Equal("stub", Value("Provider"));
    }

    [Fact]
    public void Business_team_exposes_require_manager_without_opening_require_access()
    {
        var service = GateBil.Find("BusinessTeamService");
        Assert.True(service.GetMethod("RequireManagerAsync") is not null, "BusinessTeamService sem RequireManagerAsync público");
        Assert.Equal(["Uid", "Role"], GateBil.Find("BusinessManagerAccess").GetConstructors().Single().GetParameters().Select(p => p.Name!));
        Assert.Null(service.GetMethod("RequireAccessAsync"));
    }

    [Fact]
    public void Production_refuses_to_start_with_stub_provider_and_starts_when_billing_is_off()
    {
        using var refused = new GateProductionFactory(GateBil.Settings());
        var error = Assert.ThrowsAny<Exception>(() => refused.CreateClient());
        Assert.Contains("Billing", error.ToString());

        using var off = new GateProductionFactory(GateBil.Settings(("Billing:Enabled", "false")));
        using var client = off.CreateClient();
        Assert.True(client.GetAsync("/health/live").GetAwaiter().GetResult().IsSuccessStatusCode);
    }
}
