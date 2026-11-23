// Gates FC-002-ISOLAMENTO, FC-002-CONFIG-ADITIVO e a parte dotnet de FC-002-ZERO-HARDCODE (template).
// Papéis: leitura para os quatro papéis; escrita (brandkit.manage) só para owner e admin; recurso de outra conta responde 404.
using System.Text.Json;

namespace Fluxo.Api.Tests;

public sealed class GateFc002AccessTests
{
    private static async Task<(string Id, string Owner, string Admin, string Editor, string Viewer)> SeedTeamAsync()
    {
        var (id, owner) = await GateFc.SeedBusinessAsync();
        return (id, owner, await GateFc.SeedMemberAsync(id, "ADMIN"), await GateFc.SeedMemberAsync(id, "EDITOR"), await GateFc.SeedMemberAsync(id, "VIEWER"));
    }

    private static (HttpMethod Method, string Path, object? Body)[] Writes(string business, Guid? asset = null) =>
    [
        (HttpMethod.Put, "/palette", new { colors = new[] { "#FFFFFF", "#000000" } }),
        (HttpMethod.Post, "/assets/uploads", new { purpose = "template", fileName = "a.png", contentType = "image/png", sizeBytes = 100 }),
        (HttpMethod.Post, "/templates", new { assetId = asset ?? Guid.NewGuid(), viewportPreset = "feed_square" }),
        (HttpMethod.Put, "/watermark", new { assetId = asset ?? Guid.NewGuid(), corner = "top_left" }),
        (HttpMethod.Delete, "/watermark", null),
        (HttpMethod.Put, "/templates/order", new { ids = Array.Empty<Guid>() }),
        (HttpMethod.Delete, $"/templates/{Guid.NewGuid()}", null),
    ];

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Anonymous_gets_401_and_strangers_and_unknown_businesses_get_403()
    {
        var team = await SeedTeamAsync();
        var (factory, _) = GateFc2.Api();
        await using var _f = factory;
        using var anonymous = factory.CreateClient();
        var denied = await GateFc2.CallAsync(anonymous, HttpMethod.Get, GateFc2.Route(team.Id, ""));
        Assert.Equal(401, denied.Status);
        Assert.Equal("firebase_id_token_required", GateFc.Code(denied.Body));
        var deniedWrite = await GateFc2.CallAsync(anonymous, HttpMethod.Put, GateFc2.Route(team.Id, "/palette"), new { colors = new[] { "#FFFFFF", "#000000" } });
        Assert.Equal(401, deniedWrite.Status);

        using var stranger = factory.Client($"user:stranger-{Guid.NewGuid():N}");
        var read = await GateFc2.CallAsync(stranger, HttpMethod.Get, GateFc2.Route(team.Id, ""));
        Assert.Equal(403, read.Status);
        Assert.Equal("business_access_denied", GateFc.Code(read.Body));
        foreach (var (method, path, body) in Writes(team.Id))
            Assert.True((await GateFc2.CallAsync(stranger, method, GateFc2.Route(team.Id, path), body)).Status == 403, $"estranho: {method} {path}");
        var unknown = await GateFc2.CallAsync(stranger, HttpMethod.Get, GateFc2.Route($"nao-existe-{Guid.NewGuid():N}", ""));
        Assert.Equal(403, unknown.Status);
        var missing = await GateFc2.CallAsync(factory.Client($"user:{team.Owner}"), HttpMethod.Get, "/api/v1/creator/brand-kit");
        Assert.Equal(422, missing.Status);
        Assert.Equal("creator_business_required", GateFc.Code(missing.Body));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Editor_and_viewer_read_but_cannot_write_while_owner_and_admin_write()
    {
        var team = await SeedTeamAsync();
        var (factory, storage) = GateFc2.Api();
        await using var _f = factory;
        foreach (var (role, uid) in new[] { ("editor", team.Editor), ("viewer", team.Viewer) })
        {
            using var client = factory.Client($"user:{uid}");
            var read = await GateFc2.CallAsync(client, HttpMethod.Get, GateFc2.Route(team.Id, ""));
            Assert.True(read.Status == 200, $"{role} lendo: HTTP {read.Status}");
            Assert.Contains("private", read.Raw.Headers.CacheControl?.ToString() ?? "");
            Assert.Contains("no-store", read.Raw.Headers.CacheControl?.ToString() ?? "");
            foreach (var (method, path, body) in Writes(team.Id))
            {
                var write = await GateFc2.CallAsync(client, method, GateFc2.Route(team.Id, path), body);
                Assert.True(write.Status == 403, $"{role}: {method} {path} deveria ser 403, veio {write.Status}");
                Assert.Equal("creator_permission_denied", GateFc.Code(write.Body));
            }
        }
        Assert.Empty(storage.UploadSigns);
        foreach (var uid in new[] { team.Owner, team.Admin })
        {
            using var client = factory.Client($"user:{uid}");
            Assert.Equal(200, (await GateFc2.CallAsync(client, HttpMethod.Get, GateFc2.Route(team.Id, ""))).Status);
            Assert.Equal(200, (await GateFc2.CallAsync(client, HttpMethod.Put, GateFc2.Route(team.Id, "/palette"), new { colors = new[] { "#FFFFFF", "#000000" } })).Status);
            Assert.True(GateFc2.Ok((await GateFc2.RequestUploadAsync(client, team.Id, "template", "image/png", 100)).Status));
        }
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Assets_and_templates_of_another_business_answer_404_never_403()
    {
        var mine = await SeedTeamAsync();
        var theirs = await SeedTeamAsync();
        var (factory, storage) = GateFc2.Api();
        await using var _f = factory;
        using var me = factory.Client($"user:{mine.Owner}");
        using var them = factory.Client($"user:{theirs.Owner}");
        var myAsset = await GateFc2.ReadyAssetAsync(me, storage, mine.Id);
        var theirAsset = await GateFc2.ReadyAssetAsync(them, storage, theirs.Id);
        var theirWatermark = await GateFc2.ReadyAssetAsync(them, storage, theirs.Id, "watermark");
        var theirTemplate = Guid.Parse((await GateFc2.CreateTemplateAsync(them, theirs.Id, theirAsset)).Body.GetProperty("id").GetString()!);
        var myTemplate = Guid.Parse((await GateFc2.CreateTemplateAsync(me, mine.Id, myAsset)).Body.GetProperty("id").GetString()!);
        var pendingTheirs = Guid.Parse((await GateFc2.RequestUploadAsync(them, theirs.Id, "template", "image/png", 100)).Body.GetProperty("assetId").GetString()!);

        var attempts = new (string Why, HttpMethod Method, string Path, object? Body, string Code)[]
        {
            ("template com asset alheio", HttpMethod.Post, "/templates", new { assetId = theirAsset, viewportPreset = "feed_square" }, "creator_asset_not_found"),
            ("marca d'água com asset alheio", HttpMethod.Put, "/watermark", new { assetId = theirWatermark, corner = "top_left" }, "creator_asset_not_found"),
            ("complete de asset alheio", HttpMethod.Post, $"/assets/{pendingTheirs}/complete", null, "creator_asset_not_found"),
            ("PATCH em template alheio", HttpMethod.Patch, $"/templates/{theirTemplate}", new { name = "invadido" }, "creator_template_not_found"),
            ("DELETE em template alheio", HttpMethod.Delete, $"/templates/{theirTemplate}", null, "creator_template_not_found"),
            ("replace de template alheio", HttpMethod.Post, $"/templates/{theirTemplate}/replace", new { assetId = myAsset }, "creator_template_not_found"),
            ("replace com asset alheio", HttpMethod.Post, $"/templates/{myTemplate}/replace", new { assetId = theirAsset }, "creator_asset_not_found"),
            ("asset inexistente", HttpMethod.Post, "/templates", new { assetId = Guid.NewGuid(), viewportPreset = "feed_square" }, "creator_asset_not_found"),
        };
        foreach (var (why, method, path, body, code) in attempts)
        {
            var result = await GateFc2.CallAsync(me, method, GateFc2.Route(mine.Id, path), body);
            Assert.True(result.Status == 404, $"{why}: esperava 404, veio {result.Status} {result.Body}");
            Assert.Equal(code, GateFc.Code(result.Body));
        }
        var order = await GateFc2.CallAsync(me, HttpMethod.Put, GateFc2.Route(mine.Id, "/templates/order"), new { ids = new[] { theirTemplate } });
        Assert.True(order.Status is 404 or 422, $"order com template alheio: HTTP {order.Status}");
        Assert.Null(await GateFc2.ScalarAsync($"SELECT deleted_at FROM fluxo.creator_templates WHERE id = '{theirTemplate}'"));
        Assert.Equal(theirAsset.ToString(), await GateFc2.ScalarAsync($"SELECT asset_id FROM fluxo.creator_templates WHERE id = '{theirTemplate}'"));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Responses_never_carry_uid_email_document_bucket_or_storage_paths()
    {
        var team = await SeedTeamAsync();
        var (factory, storage) = GateFc2.Api();
        await using var _f = factory;
        using var owner = factory.Client($"user:{team.Owner}");
        var asset = await GateFc2.ReadyAssetAsync(owner, storage, team.Id);
        var mark = await GateFc2.ReadyAssetAsync(owner, storage, team.Id, "watermark");
        Assert.Equal(201, (await GateFc2.CreateTemplateAsync(owner, team.Id, asset)).Status);
        Assert.Equal(200, (await GateFc2.CallAsync(owner, HttpMethod.Put, GateFc2.Route(team.Id, "/watermark"), new { assetId = mark, corner = "top_right" })).Status);
        Assert.Equal(200, (await GateFc2.CallAsync(owner, HttpMethod.Put, GateFc2.Route(team.Id, "/palette"), new { colors = new[] { "#FFFFFF", "#000000" } })).Status);
        var kit = await GateFc2.CallAsync(owner, HttpMethod.Get, GateFc2.Route(team.Id, ""));
        Assert.Equal(200, kit.Status);
        var forbidden = new[] { "cpf", "cnpj", "email", "document", "uid", "bucket", "objectpath", "stagingpath" };
        Assert.Empty(GateFc.PropertyNames(kit.Body).Select(n => n.ToLowerInvariant()).Where(n => forbidden.Any(n.Contains)));
        var withoutUrls = string.Join(' ', EnumerateExceptUrls(kit.Body));
        foreach (var leak in new[] { team.Owner, team.Admin, "@example.test", "staging/", "creator/assets/", "fluxo-gate-bucket" })
            Assert.DoesNotContain(leak, withoutUrls);
    }

    private static IEnumerable<string> EnumerateExceptUrls(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
            foreach (var property in element.EnumerateObject().Where(p => !p.Name.EndsWith("Url", StringComparison.OrdinalIgnoreCase)))
            {
                yield return property.Name;
                foreach (var inner in EnumerateExceptUrls(property.Value)) yield return inner;
            }
        else if (element.ValueKind == JsonValueKind.Array)
            foreach (var item in element.EnumerateArray())
                foreach (var inner in EnumerateExceptUrls(item)) yield return inner;
        else yield return element.ToString();
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Config_exposes_asset_and_contrast_limits_and_the_four_new_enums_additively()
    {
        var (id, owner) = await GateFc.SeedBusinessAsync();
        await using var factory = new DebateApiFactory(GateFc.C, settings: GateFc.Settings());
        using var client = factory.Client($"user:{owner}");
        var result = await GateFc.GetAsync(client, $"/api/v1/creator/config?businessId={id}");
        Assert.Equal(200, result.Status);
        Assert.Equal(1, result.Body.GetProperty("version").GetInt32());
        var assets = result.Body.GetProperty("limits").GetProperty("assets");
        var expected = new Dictionary<string, double>
        {
            ["maxSidePx"] = 4096, ["clientMaxSideFactor"] = 2, ["clientQuality"] = 0.82, ["svgMaxBytes"] = 524288, ["uploadUrlMinutes"] = 15, ["templateNameMaxChars"] = 80,
        };
        foreach (var (name, value) in expected) Assert.Equal(value, assets.GetProperty(name).GetDouble(), 6);
        var contrast = result.Body.GetProperty("limits").GetProperty("contrast");
        Assert.Equal(4.5, contrast.GetProperty("goodMin").GetDouble(), 6);
        Assert.Equal(3.0, contrast.GetProperty("warningMin").GetDouble(), 6);
        var enums = result.Body.GetProperty("enums");
        Assert.Equal(new[] { "template", "watermark" }.Order(), GateFc.Strings(enums.GetProperty("assetPurpose")).Order());
        Assert.Equal(new[] { "jpeg", "png", "svg", "webp" }.Order(), GateFc.Strings(enums.GetProperty("assetFormat")).Order());
        Assert.Equal(new[] { "bg1", "text1", "bg2", "text2", "accent" }.Order(), GateFc.Strings(enums.GetProperty("paletteRole")).Order());
        Assert.Equal(new[] { "good", "warning", "needs_confirmation" }.Order(), GateFc.Strings(enums.GetProperty("contrastLevel")).Order());
        var names = GateFc.PropertyNames(result.Body).Select(n => n.ToLowerInvariant()).ToArray();
        Assert.Empty(names.Where(n => n.Contains("cpf") || n.Contains("cnpj") || n.Contains("email") || n.Contains("document") || n.Contains("bucket")));
    }

    [Fact]
    public void Invalid_asset_or_contrast_ranges_stop_the_startup_citing_creator_keys()
    {
        GateFc.AssertStartupFails(GateFc.Settings((GateFc.KeyOf("WarningMin"), "5"), (GateFc.KeyOf("GoodMin"), "4.5")), "Creator:Contrast");
        GateFc.AssertStartupFails(GateFc.Settings((GateFc.KeyOf("MaxSidePx"), "0")));
        GateFc.AssertStartupFails(GateFc.Settings((GateFc.KeyOf("PendingMaxPerBusiness"), "0")));
        GateFc.AssertStartupFails(GateFc.Settings((GateFc.KeyOf("SvgMaxNodes"), "0")));
        GateFc.AssertStartupFails(GateFc.Settings((GateFc.KeyOf("UploadUrlMinutes"), "0")));
    }
}
