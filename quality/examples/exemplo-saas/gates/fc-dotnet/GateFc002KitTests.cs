// Gates FC-002-UPLOAD-URL, LIMITE-TEMPLATES, MARCA-DAGUA, IMUTAVEL e TEMPLATES-CRUD (template). HTTP + SQL + storage falso.
// Convenção lida pelo gate: template = { id, viewportPreset, name, focalPoint{x,y}, position, previewUrl, bytes, originalBytes, savedBytes };
// GET /brand-kit = { templates[], templatesUsed, templatesLimit, watermark|null, palette }; watermark = { corner, scale, margin, opacity, defaultOn, previewUrl }.
// Extensões de erro (limit, current, reason) são campos do Problem Details.
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Fluxo.Api.Tests;

public sealed class GateFc002KitTests
{
    private static async Task<(DebateApiFactory Factory, FakeCreatorStorage Storage, HttpClient Client, string Business)> SetupAsync(params (string, string?)[] extra)
    {
        var (id, owner) = await GateFc.SeedBusinessAsync();
        var (factory, storage) = GateFc2.Api(extra);
        return (factory, storage, factory.Client($"user:{owner}"), id);
    }

    private static Task<(int Status, JsonElement Body, HttpResponseMessage Raw)> Kit(HttpClient c, string business) => GateFc2.CallAsync(c, HttpMethod.Get, GateFc2.Route(business, ""));
    private static Guid TemplateId(JsonElement body) => Guid.Parse(body.GetProperty("id").GetString()!);
    private static Task<(int Status, JsonElement Body, HttpResponseMessage Raw)> PutWatermark(HttpClient c, string business, object body) =>
        GateFc2.CallAsync(c, HttpMethod.Put, GateFc2.Route(business, "/watermark"), body);

    // ───────────────────────── UPLOAD-URL ─────────────────────────

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Upload_url_is_a_put_with_pinned_type_size_expiry_and_an_opaque_staging_path()
    {
        var (factory, storage, client, business) = await SetupAsync((GateFc.KeyOf("UploadUrlMinutes"), "7"));
        await using var _ = factory;
        var before = DateTimeOffset.UtcNow;
        var result = await GateFc2.RequestUploadAsync(client, business, "template", "image/png", 1234, "Minha Logo (Final).PNG", original: 3_355_443);
        Assert.True(GateFc2.Ok(result.Status), $"HTTP {result.Status} {result.Body}");
        var body = result.Body;
        var id = Guid.Parse(body.GetProperty("assetId").GetString()!);
        Assert.Equal("PUT", body.GetProperty("method").GetString());
        Assert.False(string.IsNullOrWhiteSpace(body.GetProperty("uploadUrl").GetString()));
        var headers = body.GetProperty("headers");
        Assert.Equal("image/png", headers.GetProperty("content-type").GetString());
        Assert.Equal("0,1234", headers.GetProperty("x-goog-content-length-range").GetString());
        var expires = body.GetProperty("expiresAt").GetDateTimeOffset();
        Assert.InRange((expires - before).TotalMinutes, 6.0, 8.0);

        var sign = storage.UploadSigns.Single();
        Assert.Equal($"staging/creator/{id:N}", sign.Path);
        Assert.Equal("image/png", sign.ContentType);
        Assert.Equal(1234, sign.SizeBytes);
        Assert.Equal(TimeSpan.FromMinutes(7), sign.Lifetime);
        Assert.DoesNotContain(business, sign.Path);
        Assert.DoesNotContain("minha", sign.Path, StringComparison.OrdinalIgnoreCase);

        var names = GateFc.PropertyNames(body).Select(n => n.ToLowerInvariant()).ToArray();
        Assert.Empty(names.Where(n => n.Contains("objectpath") || n.Contains("stagingpath") || n.Contains("bucket") || n == "path"));
        var withoutUrl = string.Join(' ', body.EnumerateObject().Where(p => p.Name != "uploadUrl").Select(p => p.Value.GetRawText()));
        Assert.DoesNotContain("staging/", withoutUrl);
        Assert.DoesNotContain("fluxo-gate-bucket", withoutUrl);

        var row = await GateFc2.RowAsync($"SELECT status, purpose, declared_content_type, safe_file_name, size_bytes, original_bytes, business_id FROM fluxo.creator_assets WHERE id = '{id}'");
        Assert.Equal(["pending", "template", "image/png"], row[..3]);
        Assert.Matches("^[a-z0-9._-]{1,80}$", row[3]);
        Assert.Equal(["1234", "3355443", business], row[4..]);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Invalid_upload_requests_are_refused_before_any_signature()
    {
        var (factory, storage, client, business) = await SetupAsync();
        await using var _ = factory;
        var cases = new (string Why, string Purpose, string Type, long Size, int[] Statuses)[]
        {
            ("MIME fora da lista", "template", "image/gif", 100, [422]), ("webp não é formato de template", "template", "image/webp", 100, [422]),
            ("tamanho zero", "template", "image/png", 0, [422]), ("tamanho negativo", "template", "image/png", -5, [422]),
            ("acima do teto de 10 MB", "template", "image/png", 10_485_761, [413]), ("SVG acima do teto próprio", "template", "image/svg+xml", 524_289, [413, 422]),
            ("purpose inválido", "banner", "image/png", 100, [422]), ("MIME de marca d'água fora da lista", "watermark", "image/gif", 100, [422]),
        };
        foreach (var (why, purpose, type, size, statuses) in cases)
        {
            var result = await GateFc2.RequestUploadAsync(client, business, purpose, type, size);
            Assert.True(statuses.Contains(result.Status), $"{why}: HTTP {result.Status}");
        }
        Assert.Empty(storage.UploadSigns);
        Assert.True(GateFc2.Ok((await GateFc2.RequestUploadAsync(client, business, "watermark", "image/webp", 100)).Status), "webp é aceito como marca d'água");
        Assert.True(GateFc2.Ok((await GateFc2.RequestUploadAsync(client, business, "template", "image/png", 10_485_760)).Status), "10 MB exatos cabem");
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Empty_bucket_answers_503_creator_storage_unavailable()
    {
        var (id, owner) = await GateFc.SeedBusinessAsync();
        // Gate corrigido: PermitLimit 100000 derrubava a subida da API (a validação aceita 1..10000); 10000 é o maior valor válido.
        await using var factory = new DebateApiFactory(GateFc.C, settings: GateFc.Settings(("Creator:AssetBucket", ""), ("RateLimiting:PermitLimit", "10000")));
        using var client = factory.Client($"user:{owner}");
        var result = await GateFc2.RequestUploadAsync(client, id, "template", "image/png", 100);
        Assert.Equal(503, result.Status);
        Assert.Equal("creator_storage_unavailable", GateFc.Code(result.Body));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Pending_uploads_above_the_ceiling_answer_429_creator_uploads_pending()
    {
        var (factory, storage, client, business) = await SetupAsync((GateFc.KeyOf("PendingMaxPerBusiness"), "3"));
        await using var _ = factory;
        for (var i = 0; i < 3; i++) Assert.True(GateFc2.Ok((await GateFc2.RequestUploadAsync(client, business, "template", "image/png", 100)).Status));
        var over = await GateFc2.RequestUploadAsync(client, business, "template", "image/png", 100);
        Assert.Equal(429, over.Status);
        Assert.Equal("creator_uploads_pending", GateFc.Code(over.Body));
        Assert.Equal(3, storage.UploadSigns.Count);
        var (otherId, otherOwner) = await GateFc.SeedBusinessAsync();
        using var other = factory.Client($"user:{otherOwner}");
        Assert.True(GateFc2.Ok((await GateFc2.RequestUploadAsync(other, otherId, "template", "image/png", 100)).Status), "o teto é por conta");
    }

    // ───────────────────────── LIMITE-TEMPLATES ─────────────────────────

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Parallel_template_creation_never_passes_the_limit_and_deleting_frees_a_slot()
    {
        var (factory, storage, client, business) = await SetupAsync((GateFc.KeyOf("TemplatesPerBusiness"), "3"));
        await using var _ = factory;
        var assets = new List<Guid>();
        for (var i = 0; i < 7; i++) assets.Add(await GateFc2.ReadyAssetAsync(client, storage, business));
        var results = await Task.WhenAll(assets.Take(6).Select(a => GateFc2.CreateTemplateAsync(client, business, a)));
        Assert.Equal(3, results.Count(r => r.Status == 201));
        var refused = results.Where(r => r.Status == 409).ToArray();
        Assert.Equal(3, refused.Length);
        foreach (var r in refused)
        {
            Assert.Equal("creator_template_limit", GateFc.Code(r.Body));
            Assert.Equal(3, r.Body.GetProperty("limit").GetInt32());
            Assert.Equal(3, r.Body.GetProperty("current").GetInt32());
            Assert.Matches(new Regex("[à-úÀ-Ú]|\\b(limite|máximo|modelos?)\\b", RegexOptions.IgnoreCase), r.Body.GetProperty("detail").GetString()!);
        }
        Assert.Equal(3, int.Parse(await GateFc2.ScalarAsync($"SELECT count(*) FROM fluxo.creator_templates WHERE business_id = '{business}' AND deleted_at IS NULL") ?? "-1"));
        var kit = await Kit(client, business);
        Assert.Equal(3, kit.Body.GetProperty("templatesUsed").GetInt32());
        Assert.Equal(3, kit.Body.GetProperty("templatesLimit").GetInt32());

        var precheck = await GateFc2.RequestUploadAsync(client, business, "template", "image/png", 100);
        Assert.Equal(409, precheck.Status);
        Assert.Equal("creator_template_limit", GateFc.Code(precheck.Body));

        var created = results.First(r => r.Status == 201);
        var removed = await GateFc2.CallAsync(client, HttpMethod.Delete, GateFc2.Route(business, $"/templates/{TemplateId(created.Body)}"));
        Assert.True(GateFc2.Ok(removed.Status), $"DELETE: HTTP {removed.Status}");
        var spare = assets.Last();
        Assert.Equal(201, (await GateFc2.CreateTemplateAsync(client, business, spare)).Status);
        var again = await GateFc2.CreateTemplateAsync(client, business, assets[results.ToList().FindIndex(r => r.Status == 409)]);
        Assert.Equal(409, again.Status);

        var (otherId, otherOwner) = await GateFc.SeedBusinessAsync();
        using var other = factory.Client($"user:{otherOwner}");
        var otherAsset = await GateFc2.ReadyAssetAsync(other, storage, otherId);
        Assert.Equal(201, (await GateFc2.CreateTemplateAsync(other, otherId, otherAsset)).Status);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Template_position_grows_and_the_name_has_a_ceiling()
    {
        var (factory, storage, client, business) = await SetupAsync();
        await using var _ = factory;
        var first = await GateFc2.CreateTemplateAsync(client, business, await GateFc2.ReadyAssetAsync(client, storage, business), "story", "Capa");
        var second = await GateFc2.CreateTemplateAsync(client, business, await GateFc2.ReadyAssetAsync(client, storage, business), "landscape");
        Assert.Equal(201, first.Status);
        Assert.Equal(201, second.Status);
        Assert.Equal(second.Body.GetProperty("position").GetInt32(), first.Body.GetProperty("position").GetInt32() + 1);
        Assert.Equal("story", first.Body.GetProperty("viewportPreset").GetString());
        var tooLong = await GateFc2.CreateTemplateAsync(client, business, await GateFc2.ReadyAssetAsync(client, storage, business), "story", new string('n', 81));
        Assert.Equal(422, tooLong.Status);
        var badPreset = await GateFc2.CreateTemplateAsync(client, business, await GateFc2.ReadyAssetAsync(client, storage, business), "link_card");
        Assert.Equal(422, badPreset.Status);
        var wrongPurpose = await GateFc2.CreateTemplateAsync(client, business, await GateFc2.ReadyAssetAsync(client, storage, business, "watermark"));
        Assert.Equal(422, wrongPurpose.Status);
        var pending = await GateFc2.RequestUploadAsync(client, business, "template", "image/png", 100);
        var notReady = await GateFc2.CreateTemplateAsync(client, business, Guid.Parse(pending.Body.GetProperty("assetId").GetString()!));
        Assert.True(notReady.Status is 409 or 422, $"asset pendente virou template: HTTP {notReady.Status}");
    }

    // ───────────────────────── MARCA-DAGUA ─────────────────────────

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Watermark_defaults_come_from_configuration_and_every_field_is_range_checked()
    {
        var (factory, storage, client, business) = await SetupAsync();
        await using var _ = factory;
        var config = await GateFc2.CallAsync(client, HttpMethod.Get, $"/api/v1/creator/config?businessId={business}");
        var limits = config.Body.GetProperty("limits").GetProperty("watermark");
        var asset = await GateFc2.ReadyAssetAsync(client, storage, business, "watermark");
        var saved = await PutWatermark(client, business, new { assetId = asset, corner = "bottom_right" });
        Assert.True(saved.Status == 200, $"HTTP {saved.Status} {saved.Body}");
        var mark = saved.Body.TryGetProperty("watermark", out var inner) ? inner : saved.Body;
        Assert.Equal("bottom_right", mark.GetProperty("corner").GetString());
        Assert.Equal(limits.GetProperty("scaleDefault").GetDouble(), mark.GetProperty("scale").GetDouble(), 6);
        Assert.Equal(limits.GetProperty("marginDefault").GetDouble(), mark.GetProperty("margin").GetDouble(), 6);
        Assert.Equal(limits.GetProperty("opacityDefault").GetDouble(), mark.GetProperty("opacity").GetDouble(), 6);
        var read = (await Kit(client, business)).Body.GetProperty("watermark");
        Assert.Equal("bottom_right", read.GetProperty("corner").GetString());
        Assert.False(string.IsNullOrWhiteSpace(read.GetProperty("previewUrl").GetString()));

        var custom = await PutWatermark(client, business, new { assetId = asset, corner = "top_left", scale = 0.2, margin = 0.05, opacity = 0.5, defaultOn = false });
        Assert.Equal(200, custom.Status);
        var customMark = (await Kit(client, business)).Body.GetProperty("watermark");
        Assert.Equal((0.2, 0.05, 0.5, false), (customMark.GetProperty("scale").GetDouble(), customMark.GetProperty("margin").GetDouble(), customMark.GetProperty("opacity").GetDouble(), customMark.GetProperty("defaultOn").GetBoolean()));

        var invalid = new (string Why, object Body, string Range)[]
        {
            ("escala acima", new { assetId = asset, corner = "top_left", scale = 0.5 }, "0[.,]3"), ("escala abaixo", new { assetId = asset, corner = "top_left", scale = 0.01 }, "0[.,]05"),
            ("margem acima", new { assetId = asset, corner = "top_left", margin = 0.5 }, "0[.,]1"), ("margem abaixo", new { assetId = asset, corner = "top_left", margin = 0.0 }, "0[.,]02"),
            ("opacidade abaixo", new { assetId = asset, corner = "top_left", opacity = 0.1 }, "0[.,]3"), ("opacidade acima", new { assetId = asset, corner = "top_left", opacity = 1.5 }, "1"),
        };
        foreach (var (why, body, range) in invalid)
        {
            var result = await PutWatermark(client, business, body);
            Assert.True(result.Status == 422, $"{why}: HTTP {result.Status}");
            Assert.Equal("creator_watermark_invalid", GateFc.Code(result.Body));
            Assert.Matches(range, result.Body.GetProperty("detail").GetString()!);
        }
        Assert.Equal(422, (await PutWatermark(client, business, new { assetId = asset, corner = "center" })).Status);
        Assert.Equal(422, (await PutWatermark(client, business, new { assetId = asset })).Status);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Watermark_accepts_webp_and_svg_rejects_other_purposes_and_delete_clears_it()
    {
        var (factory, storage, client, business) = await SetupAsync();
        await using var _ = factory;
        var template = await GateFc2.ReadyAssetAsync(client, storage, business);
        var wrongPurpose = await PutWatermark(client, business, new { assetId = template, corner = "top_right" });
        Assert.Equal(422, wrongPurpose.Status);
        var pending = await GateFc2.RequestUploadAsync(client, business, "watermark", "image/png", 100);
        var notReady = await PutWatermark(client, business, new { assetId = Guid.Parse(pending.Body.GetProperty("assetId").GetString()!), corner = "top_right" });
        Assert.True(notReady.Status is 409 or 422);

        var webp = await GateFc2.ReadyAssetAsync(client, storage, business, "watermark", Convert.FromBase64String(GateFc2.Webp1x1), "image/webp");
        Assert.Equal(200, (await PutWatermark(client, business, new { assetId = webp, corner = "top_left" })).Status);
        var svg = await GateFc2.ReadyAssetAsync(client, storage, business, "watermark", GateFc2.Utf8(GateFc2.Svg("<circle cx=\"50\" cy=\"50\" r=\"40\"/>")), "image/svg+xml");
        Assert.Equal(200, (await PutWatermark(client, business, new { assetId = svg, corner = "bottom_left" })).Status);
        Assert.NotEmpty(await GateFc2.ScalarAsync($"SELECT retired_at FROM fluxo.creator_assets WHERE id = '{webp}'") ?? "");

        var cleared = await GateFc2.CallAsync(client, HttpMethod.Delete, GateFc2.Route(business, "/watermark"));
        Assert.True(GateFc2.Ok(cleared.Status), $"HTTP {cleared.Status}");
        var kit = await Kit(client, business);
        Assert.True(!kit.Body.TryGetProperty("watermark", out var mark) || mark.ValueKind == JsonValueKind.Null, "marca d'água deveria estar zerada");
    }

    // ───────────────────────── IMUTAVEL ─────────────────────────

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Replace_and_delete_keep_every_asset_row_and_never_delete_a_ready_object()
    {
        var (factory, storage, client, business) = await SetupAsync();
        await using var _ = factory;
        var first = await GateFc2.ReadyAssetAsync(client, storage, business);
        var second = await GateFc2.ReadyAssetAsync(client, storage, business, bytes: GateFc2.Png(30, 30));
        var created = await GateFc2.CreateTemplateAsync(client, business, first);
        Assert.Equal(201, created.Status);
        var id = TemplateId(created.Body);
        var firstPath = await GateFc2.ScalarAsync($"SELECT object_path FROM fluxo.creator_assets WHERE id = '{first}'");
        Assert.NotNull(firstPath);

        var replaced = await GateFc2.CallAsync(client, HttpMethod.Post, GateFc2.Route(business, $"/templates/{id}/replace"), new { assetId = second });
        Assert.True(GateFc2.Ok(replaced.Status), $"replace: HTTP {replaced.Status} {replaced.Body}");
        Assert.Equal(second.ToString(), await GateFc2.ScalarAsync($"SELECT asset_id FROM fluxo.creator_templates WHERE id = '{id}'"));
        Assert.NotNull(await GateFc2.ScalarAsync($"SELECT retired_at FROM fluxo.creator_assets WHERE id = '{first}'"));
        Assert.Null(await GateFc2.ScalarAsync($"SELECT retired_at FROM fluxo.creator_assets WHERE id = '{second}'"));
        Assert.Equal("1", await GateFc2.ScalarAsync($"SELECT count(*) FROM fluxo.creator_assets WHERE id = '{first}'"));
        Assert.True(storage.Objects.ContainsKey(firstPath!), "o objeto do asset aposentado deve continuar no bucket");

        var removed = await GateFc2.CallAsync(client, HttpMethod.Delete, GateFc2.Route(business, $"/templates/{id}"));
        Assert.True(GateFc2.Ok(removed.Status));
        Assert.Equal("1", await GateFc2.ScalarAsync($"SELECT count(*) FROM fluxo.creator_templates WHERE id = '{id}'"));
        Assert.NotNull(await GateFc2.ScalarAsync($"SELECT deleted_at FROM fluxo.creator_templates WHERE id = '{id}'"));
        Assert.NotNull(await GateFc2.ScalarAsync($"SELECT retired_at FROM fluxo.creator_assets WHERE id = '{second}'"));
        Assert.Equal("2", await GateFc2.ScalarAsync($"SELECT count(*) FROM fluxo.creator_assets WHERE business_id = '{business}' AND status = 'ready'"));
        Assert.All(storage.Deleted, path => Assert.StartsWith("staging/", path));
        var kit = await Kit(client, business);
        Assert.Equal(0, kit.Body.GetProperty("templatesUsed").GetInt32());
    }

    // ───────────────────────── TEMPLATES-CRUD ─────────────────────────

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Kit_lists_templates_with_sizes_preview_and_supports_patch_and_reorder()
    {
        var (factory, storage, client, business) = await SetupAsync((GateFc.KeyOf("DownloadUrlMinutes"), "5"));
        await using var _ = factory;
        var png = GateFc2.Png(200, 100);
        var upload = await GateFc2.RequestUploadAsync(client, business, "template", "image/png", png.Length, "capa.png", original: 3_355_443);
        var assetId = Guid.Parse(upload.Body.GetProperty("assetId").GetString()!);
        storage.Put(assetId, "image/png", png);
        Assert.True(GateFc2.Ok((await GateFc2.CallAsync(client, HttpMethod.Post, GateFc2.Route(business, $"/assets/{assetId}/complete"))).Status));
        var one = await GateFc2.CreateTemplateAsync(client, business, assetId, "feed_portrait", "Capa");
        var two = await GateFc2.CreateTemplateAsync(client, business, await GateFc2.ReadyAssetAsync(client, storage, business), "story", "Story");
        var (oneId, twoId) = (TemplateId(one.Body), TemplateId(two.Body));

        var kit = await Kit(client, business);
        var templates = kit.Body.GetProperty("templates").EnumerateArray().ToArray();
        Assert.Equal([oneId.ToString(), twoId.ToString()], templates.Select(t => t.GetProperty("id").GetString()!).ToArray());
        var first = templates[0];
        Assert.Equal(png.Length, first.GetProperty("bytes").GetInt64());
        Assert.Equal(3_355_443, first.GetProperty("originalBytes").GetInt64());
        Assert.Equal(3_355_443 - png.Length, first.GetProperty("savedBytes").GetInt64());
        Assert.False(string.IsNullOrWhiteSpace(first.GetProperty("previewUrl").GetString()));
        Assert.Equal("feed_portrait", first.GetProperty("viewportPreset").GetString());
        Assert.Contains(storage.DownloadSigns, d => d.Lifetime == TimeSpan.FromMinutes(5));

        var patched = await GateFc2.CallAsync(client, HttpMethod.Patch, GateFc2.Route(business, $"/templates/{oneId}"),
            new { name = "Capa nova", focalPoint = new { x = 0.25, y = 0.75 }, viewportPreset = "landscape" });
        Assert.True(GateFc2.Ok(patched.Status), $"PATCH: HTTP {patched.Status} {patched.Body}");
        Assert.Equal(["Capa nova", "landscape"], (await GateFc2.RowAsync($"SELECT name, viewport_preset FROM fluxo.creator_templates WHERE id = '{oneId}'")));
        Assert.Equal(["0.250", "0.750"], await GateFc2.RowAsync($"SELECT focal_x::text, focal_y::text FROM fluxo.creator_templates WHERE id = '{oneId}'"));
        var outOfRange = await GateFc2.CallAsync(client, HttpMethod.Patch, GateFc2.Route(business, $"/templates/{oneId}"), new { focalPoint = new { x = 1.5, y = 0.5 } });
        Assert.Equal(422, outOfRange.Status);

        var reorder = await GateFc2.CallAsync(client, HttpMethod.Put, GateFc2.Route(business, "/templates/order"), new { ids = new[] { twoId, oneId } });
        Assert.True(GateFc2.Ok(reorder.Status), $"order: HTTP {reorder.Status} {reorder.Body}");
        var ordered = (await Kit(client, business)).Body.GetProperty("templates").EnumerateArray().Select(t => t.GetProperty("id").GetString()).ToArray();
        Assert.Equal([twoId.ToString(), oneId.ToString()], ordered);
        var partial = await GateFc2.CallAsync(client, HttpMethod.Put, GateFc2.Route(business, "/templates/order"), new { ids = new[] { twoId } });
        Assert.Equal(422, partial.Status);
        var unchanged = (await Kit(client, business)).Body.GetProperty("templates").EnumerateArray().Select(t => t.GetProperty("id").GetString()).ToArray();
        Assert.Equal(ordered, unchanged);
    }
}
