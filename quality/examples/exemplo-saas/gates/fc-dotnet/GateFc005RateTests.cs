// Gates FC-005-TAXA (template, parte dotnet). Subida da API com a seção RateLimiting:Creator: bucket inválido derruba a
// subida citando a chave; buckets válidos (padrões do desenho) sobem; as constantes de política existem em
// ApiTrafficControlExtensions. A parte estática (appsettings, Development sem override, nomes exatos) fica no fc-005.test.mjs.
using System.Reflection;
using Fluxo.Api.Infrastructure.Traffic;

namespace Fluxo.Api.Tests;

public sealed class GateFc005RateTests
{
    [Fact]
    public void Startup_with_an_invalid_creator_bucket_fails_citing_the_rate_limiting_key()
    {
        GateFc.AssertStartupFails(
            GateFc.Settings(("RateLimiting:Creator:Enqueue:TokensPerSecond", "0")),
            "RateLimiting:Creator");
        GateFc.AssertStartupFails(
            GateFc.Settings(("RateLimiting:Creator:Upload:ReplenishSeconds", "0")),
            "RateLimiting:Creator");
    }

    [Fact]
    public void Startup_with_the_design_defaults_boots()
    {
        using var factory = new DebateApiFactory(null, settings: GateFc.Settings(
            ("RateLimiting:Creator:Preview:TokensPerSecond", "2"), ("RateLimiting:Creator:Preview:BurstTokens", "4"),
            ("RateLimiting:Creator:Status:TokensPerSecond", "2"), ("RateLimiting:Creator:Status:BurstTokens", "4"),
            ("RateLimiting:Creator:Enqueue:TokensPerSecond", "1"), ("RateLimiting:Creator:Enqueue:BurstTokens", "3"),
            ("RateLimiting:Creator:Upload:TokensPerSecond", "1"), ("RateLimiting:Creator:Upload:ReplenishSeconds", "2"),
            ("RateLimiting:Creator:Upload:BurstTokens", "3")));
        using var client = factory.CreateClient();
        Assert.NotNull(client);
    }

    [Fact]
    public void The_four_new_creator_policy_names_exist_and_follow_the_wire_format()
    {
        var type = typeof(ApiTrafficControlExtensions);
        foreach (var (name, expected) in new[]
        {
            ("CreatorPreviewPolicyName", "creator-preview"), ("CreatorStatusPolicyName", "creator-status"),
            ("CreatorEnqueuePolicyName", "creator-enqueue"), ("CreatorUploadPolicyName", "creator-upload"),
        })
        {
            var field = type.GetField(name, BindingFlags.Public | BindingFlags.Static);
            Assert.True(field is not null, $"ApiTrafficControlExtensions sem {name}");
            Assert.Equal(expected, field!.GetRawConstantValue());
        }
    }

    [Fact]
    public void Creator_queue_capacity_config_is_validated_at_startup_citing_the_key()
    {
        GateFc.AssertStartupFails(
            GateFc.Settings(("Creator:Queue:CapacityEtaSeconds", "0")),
            "Creator:Queue:CapacityEtaSeconds");
        GateFc.AssertStartupFails(
            GateFc.Settings(("Creator:Queue:Replicas", "0")),
            "Creator:Queue:Replicas");
    }
}
