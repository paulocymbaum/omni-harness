// Gate FC-001-CONFIG-API, FC-001-PRIVACIDADE e parte de FC-001-ZERO-HARDCODE (template). Só HTTP e SQL (PostgreSQL de teste).
using System.Text.Json;

namespace Fluxo.Api.Tests;

public sealed class GateFc001ApiTests
{
    private static DebateApiFactory Api(params (string Key, string? Value)[] extra) =>
        new(GateFc.C, settings: GateFc.Settings(extra));

    private static string Route(string? businessId) => businessId is null
        ? "/api/v1/creator/config" : $"/api/v1/creator/config?businessId={businessId}";

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Anonymous_gets_401_and_missing_business_gets_422()
    {
        var (id, owner) = await GateFc.SeedBusinessAsync();
        await using var factory = Api();
        using var anonymous = factory.CreateClient();
        var denied = await GateFc.GetAsync(anonymous, Route(id));
        Assert.Equal(401, denied.Status);
        Assert.Equal("firebase_id_token_required", GateFc.Code(denied.Body));

        using var client = factory.Client($"user:{owner}");
        foreach (var route in new[] { Route(null), Route("") })
        {
            var missing = await GateFc.GetAsync(client, route);
            Assert.Equal(422, missing.Status);
            Assert.Equal("creator_business_required", GateFc.Code(missing.Body));
        }
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Caller_without_membership_gets_403()
    {
        var (id, _) = await GateFc.SeedBusinessAsync();
        await using var factory = Api();
        using var stranger = factory.Client($"user:stranger-{Guid.NewGuid():N}");
        var result = await GateFc.GetAsync(stranger, Route(id));
        Assert.Equal(403, result.Status);
        Assert.Equal("business_access_denied", GateFc.Code(result.Body));
        var unknown = await GateFc.GetAsync(stranger, Route($"nao-existe-{Guid.NewGuid():N}"));
        Assert.Equal(403, unknown.Status);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Owner_admin_editor_viewer_get_200_with_their_permissions()
    {
        var (id, owner) = await GateFc.SeedBusinessAsync();
        var uids = new Dictionary<string, string>
        {
            ["owner"] = owner,
            ["admin"] = await GateFc.SeedMemberAsync(id, "ADMIN"),
            ["editor"] = await GateFc.SeedMemberAsync(id, "EDITOR"),
            ["viewer"] = await GateFc.SeedMemberAsync(id, "VIEWER"),
        };
        var expected = new Dictionary<string, string[]>
        {
            ["owner"] = ["creator.read", "creator.create", "creator.export", "creator.brandkit.manage"],
            ["admin"] = ["creator.read", "creator.create", "creator.export", "creator.brandkit.manage"],
            ["editor"] = ["creator.read", "creator.create", "creator.export"],
            ["viewer"] = ["creator.read"],
        };
        await using var factory = Api();
        foreach (var (role, uid) in uids)
        {
            using var client = factory.Client($"user:{uid}");
            var result = await GateFc.GetAsync(client, Route(id));
            Assert.True(result.Status == 200, $"{role}: HTTP {result.Status}");
            var access = result.Body.GetProperty("access");
            Assert.Equal(id, access.GetProperty("businessId").GetString());
            Assert.Equal(role, access.GetProperty("role").GetString());
            Assert.Equal(expected[role].Order(), GateFc.Strings(access.GetProperty("permissions")).Order());
            var cache = string.Join(",", result.Raw.Headers.CacheControl?.ToString() ?? "");
            Assert.Contains("private", cache);
            Assert.Contains("no-store", cache);
        }
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Unrecognized_member_role_gets_403_creator_access_denied()
    {
        var (id, _) = await GateFc.SeedBusinessAsync();
        var operatorUid = await GateFc.SeedMemberAsync(id, "OPERATOR");
        await using var factory = Api();
        using var client = factory.Client($"user:{operatorUid}");
        var result = await GateFc.GetAsync(client, Route(id));
        Assert.Equal(403, result.Status);
        Assert.Equal("creator_access_denied", GateFc.Code(result.Body));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Disabled_feature_answers_404_creator_disabled()
    {
        var (id, owner) = await GateFc.SeedBusinessAsync();
        await using var factory = Api(("Creator:Enabled", "false"));
        using var client = factory.Client($"user:{owner}");
        var result = await GateFc.GetAsync(client, Route(id));
        Assert.Equal(404, result.Status);
        Assert.Equal("creator_disabled", GateFc.Code(result.Body));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Payload_carries_every_limit_viewport_and_enum_from_the_spec()
    {
        var (id, owner) = await GateFc.SeedBusinessAsync();
        await using var factory = Api();
        using var client = factory.Client($"user:{owner}");
        var result = await GateFc.GetAsync(client, Route(id));
        Assert.Equal(200, result.Status);
        var root = result.Body;
        Assert.Equal(1, root.GetProperty("version").GetInt32());
        Assert.True(root.GetProperty("enabled").GetBoolean());
        Assert.False(root.GetProperty("electoralContextEnabled").GetBoolean());

        var limits = root.GetProperty("limits");
        var numbers = new Dictionary<string, double>
        {
            ["templatesPerBusiness"] = 10, ["templateMaxBytes"] = 10485760, ["paletteMinColors"] = 2, ["paletteMaxColors"] = 5,
            ["carouselMinSlides"] = 2, ["carouselMaxSlides"] = 10, ["carouselDefaultSlides"] = 5, ["inputImagesMax"] = 6,
            ["promptMaxChars"] = 2000, ["draftRetentionDays"] = 30, ["inputRetentionDays"] = 90, ["geoPageSize"] = 15,
            ["geoDebounceMs"] = 250, ["concurrentGenerationsPerBusiness"] = 2, ["maxQueuedJobsPerBusiness"] = 30,
            ["maxJobsRunningPerBusiness"] = 3,
        };
        foreach (var (name, value) in numbers) Assert.Equal(value, limits.GetProperty(name).GetDouble());
        Assert.Equal(new[] { "image/jpeg", "image/png", "image/svg+xml" }.Order(), GateFc.Strings(limits.GetProperty("templateMimeTypes")).Order());

        var watermark = limits.GetProperty("watermark");
        var marks = new Dictionary<string, double>
        {
            ["scaleMin"] = 0.05, ["scaleMax"] = 0.30, ["scaleDefault"] = 0.12, ["marginMin"] = 0.02, ["marginMax"] = 0.10,
            ["marginDefault"] = 0.04, ["opacityMin"] = 0.30, ["opacityMax"] = 1.0, ["opacityDefault"] = 0.90,
        };
        foreach (var (name, value) in marks) Assert.Equal(value, watermark.GetProperty(name).GetDouble(), 6);
        Assert.Equal(new[] { "image/png", "image/svg+xml", "image/jpeg", "image/webp" }.Order(), GateFc.Strings(watermark.GetProperty("mimeTypes")).Order());

        var presets = root.GetProperty("viewportPresets").EnumerateArray()
            .ToDictionary(p => p.GetProperty("preset").GetString()!, p => (p.GetProperty("width").GetInt32(), p.GetProperty("height").GetInt32()));
        Assert.Equal(4, presets.Count);
        Assert.Equal((1080, 1080), presets["feed_square"]);
        Assert.Equal((1080, 1350), presets["feed_portrait"]);
        Assert.Equal((1080, 1920), presets["story"]);
        Assert.Equal((1920, 1080), presets["landscape"]);

        var enums = root.GetProperty("enums");
        Assert.Equal(new[] { "top_left", "top_right", "bottom_left", "bottom_right" }.Order(), GateFc.Strings(enums.GetProperty("watermarkCorner")).Order());
        Assert.Equal(new[] { "single", "carousel" }.Order(), GateFc.Strings(enums.GetProperty("projectKind")).Order());
        Assert.Equal(new[] { "hook", "context", "data", "body", "cta" }.Order(), GateFc.Strings(enums.GetProperty("slideRole")).Order());
        Assert.Equal(new[] { "queued", "running", "validated", "rendered", "failed" }.Order(), GateFc.Strings(enums.GetProperty("slideTaskStatus")).Order());
        Assert.Equal(new[] { "owner", "admin", "editor", "viewer" }.Order(), GateFc.Strings(enums.GetProperty("memberRole")).Order());
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Response_never_exposes_document_or_email_fields()
    {
        var (id, owner) = await GateFc.SeedBusinessAsync();
        var admin = await GateFc.SeedMemberAsync(id, "ADMIN");
        await using var factory = Api();
        using var client = factory.Client($"user:{admin}");
        var result = await GateFc.GetAsync(client, Route(id));
        Assert.Equal(200, result.Status);
        var names = GateFc.PropertyNames(result.Body).Select(n => n.ToLowerInvariant()).ToArray();
        var forbidden = names.Where(n => n.Contains("cpf") || n.Contains("cnpj") || n.Contains("email") || n.Contains("document")).ToArray();
        Assert.Empty(forbidden);
        var raw = result.Body.GetRawText();
        Assert.DoesNotContain(owner, raw);
        Assert.DoesNotContain(admin, raw);
    }

    [Fact]
    public async Task Inverted_limit_range_stops_the_startup()
    {
        string? file = null;
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "backend", "src", "Fluxo.Api", "appsettings.json");
            if (File.Exists(candidate)) { file = candidate; break; }
        }
        Assert.True(file is not null, "appsettings.json da API não encontrado");
        using var doc = JsonDocument.Parse(await File.ReadAllTextAsync(file!));
        Assert.True(doc.RootElement.TryGetProperty("Creator", out var section), "appsettings.json sem seção Creator");
        string? Find(JsonElement element, string path, string name)
        {
            if (element.ValueKind != JsonValueKind.Object) return null;
            foreach (var property in element.EnumerateObject())
            {
                if (property.Name == name) return $"{path}:{name}";
                var inner = Find(property.Value, $"{path}:{property.Name}", name);
                if (inner is not null) return inner;
            }
            return null;
        }
        var key = Find(section, "Creator", "CarouselMinSlides");
        Assert.True(key is not null, "seção Creator sem CarouselMinSlides (limite deve vir da configuração)");
        await using var factory = new DebateApiFactory(null, settings: GateFc.Settings((key!, "11")));
        var error = Assert.ThrowsAny<Exception>(() => factory.CreateClient());
        Assert.Contains("Creator", error.ToString());
    }
}
