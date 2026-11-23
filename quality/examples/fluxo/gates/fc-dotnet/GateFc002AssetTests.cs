// Gates FC-002-ASSET-VALIDACAO e FC-002-SVG (template). Por HTTP, com o storage falso: upload (PUT simulado) + complete.
// A validação roda no complete, sobre os bytes (formato pela assinatura, nunca pela extensão nem pelo MIME declarado).
// Estado final lido do banco (colunas da spec): creator_assets.status/format/width/height/size_bytes/sha256.
using System.Security.Cryptography;
using System.Text;
using System.Xml.Linq;

namespace Fluxo.Api.Tests;

public sealed class GateFc002AssetTests
{
    private static async Task<(DebateApiFactory Factory, FakeCreatorStorage Storage, HttpClient Client, string Business)> SetupAsync(params (string, string?)[] extra)
    {
        var (id, owner) = await GateFc.SeedBusinessAsync();
        var (factory, storage) = GateFc2.Api(extra);
        return (factory, storage, factory.Client($"user:{owner}"), id);
    }

    private static async Task<string[]> AssetRowAsync(Guid id) =>
        await GateFc2.RowAsync($"SELECT status, coalesce(format,'-'), coalesce(width,0), coalesce(height,0), coalesce(size_bytes,0), coalesce(sha256,'-') FROM fluxo.creator_assets WHERE id = '{id}'");

    private static async Task AssertRejectedAsync(DebateApiFactory factory, FakeCreatorStorage storage, HttpClient client, string business, string contentType, byte[] bytes, string why, string? code = null, string purpose = "template")
    {
        var (id, status, body) = await GateFc2.UploadAsync(client, storage, business, purpose, contentType, bytes);
        Assert.True(status == 422, $"{why}: esperava 422, veio {status} {body}");
        if (code is not null) Assert.Equal(code, GateFc.Code(body));
        var row = await AssetRowAsync(id);
        Assert.NotEqual("ready", row[0]);
        Assert.Empty(storage.FinalWrites);
        Assert.True(storage.Deleted.Any(p => p.StartsWith("staging/", StringComparison.Ordinal)), $"{why}: o staging deveria ser apagado");
        Assert.False(storage.Objects.Keys.Any(p => p.StartsWith("staging/", StringComparison.Ordinal)), $"{why}: staging ainda existe");
        Assert.Equal(0, int.Parse(await GateFc2.ScalarAsync($"SELECT count(*) FROM fluxo.creator_assets WHERE business_id = '{business}' AND status = 'ready'") ?? "-1"));
    }

    // ───────────────────────── ASSET-VALIDACAO ─────────────────────────

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Format_comes_from_the_bytes_and_dimensions_from_the_header()
    {
        var (factory, storage, client, business) = await SetupAsync();
        await using var _ = factory;
        // Gate corrigido: WebP não é formato de template (spec e FC-001: TemplateMimeTypes = jpeg, png, svg; o KitTests exige 422);
        // vale só como marca d'água. Os casos WebP agora enviam purpose="watermark"; a prova (formato pelos bytes) é a mesma.
        var cases = new (string Purpose, string Type, byte[] Bytes, string Format, int W, int H)[]
        {
            ("template", "image/png", GateFc2.Png(640, 480), "png", 640, 480), ("template", "image/jpeg", GateFc2.Jpeg(800, 600), "jpeg", 800, 600),
            ("watermark", "image/webp", GateFc2.WebpHeader(300, 200), "webp", 300, 200), ("watermark", "image/webp", Convert.FromBase64String(GateFc2.Webp1x1), "webp", 1, 1),
            ("template", "image/svg+xml", GateFc2.Utf8(GateFc2.Svg("<rect width=\"10\" height=\"10\"/>")), "svg", 100, 100),
        };
        foreach (var (purpose, type, bytes, format, w, h) in cases)
        {
            var (id, status, body) = await GateFc2.UploadAsync(client, storage, business, purpose, type, bytes);
            Assert.True(GateFc2.Ok(status), $"{format}: HTTP {status} {body}");
            var row = await AssetRowAsync(id);
            Assert.Equal("ready", row[0]);
            Assert.Equal(format, row[1]);
            Assert.Equal((w, h), (int.Parse(row[2]), int.Parse(row[3])));
            Assert.Equal(64, row[5].Length);
            var final = storage.FinalWrites.Last();
            Assert.Matches("^creator/assets/[0-9a-f]{32}\\.(png|jpe?g|webp|svg)$", final.Path);
            Assert.Equal(long.Parse(row[4]), final.Bytes.Length);
            Assert.Equal(Convert.ToHexString(SHA256.HashData(final.Bytes)).ToLowerInvariant(), row[5].ToLowerInvariant());
            Assert.Contains(id.ToString("N"), final.Path);
        }
        Assert.True(storage.Deleted.Count(p => p.StartsWith("staging/", StringComparison.Ordinal)) >= cases.Length, "staging deve ser apagado depois do complete");
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Declared_type_that_disagrees_with_the_bytes_is_422_creator_asset_invalid()
    {
        var (factory, storage, client, business) = await SetupAsync();
        await using var _ = factory;
        await AssertRejectedAsync(factory, storage, client, business, "image/png", GateFc2.Jpeg(100, 100), "JPEG declarado como PNG", "creator_asset_invalid");
        await AssertRejectedAsync(factory, storage, client, business, "image/jpeg", GateFc2.Png(100, 100), "PNG declarado como JPEG", "creator_asset_invalid");
        await AssertRejectedAsync(factory, storage, client, business, "image/png", GateFc2.Utf8("MZ não sou imagem, mas tenho extensão .png"), "executável com extensão de imagem", "creator_asset_invalid");
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Side_above_the_ceiling_or_zero_is_422_creator_asset_dimensions_and_truncated_files_are_422()
    {
        var (factory, storage, client, business) = await SetupAsync();
        await using var _ = factory;
        await AssertRejectedAsync(factory, storage, client, business, "image/png", GateFc2.Png(5000, 100), "PNG largo demais", "creator_asset_dimensions");
        await AssertRejectedAsync(factory, storage, client, business, "image/jpeg", GateFc2.Jpeg(100, 4097), "JPEG alto demais", "creator_asset_dimensions");
        await AssertRejectedAsync(factory, storage, client, business, "image/webp", GateFc2.WebpHeader(4097, 10), "WebP largo demais", "creator_asset_dimensions", "watermark"); // WebP só como marca d'água (ver Format_comes_from_the_bytes...)
        await AssertRejectedAsync(factory, storage, client, business, "image/png", GateFc2.Png(0, 100), "PNG de largura zero", "creator_asset_dimensions");
        await AssertRejectedAsync(factory, storage, client, business, "image/png", GateFc2.PngTruncated(), "PNG truncado");
        await AssertRejectedAsync(factory, storage, client, business, "image/jpeg", GateFc2.JpegTruncated(), "JPEG truncado");
        var edge = await GateFc2.UploadAsync(client, storage, business, "template", "image/png", GateFc2.Png(4096, 4096));
        Assert.True(GateFc2.Ok(edge.Status), "4096 de lado é o teto, não passa dele");
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Side_ceiling_comes_from_configuration()
    {
        var (factory, storage, client, business) = await SetupAsync((GateFc.KeyOf("MaxSidePx"), "1000"));
        await using var _ = factory;
        await AssertRejectedAsync(factory, storage, client, business, "image/png", GateFc2.Png(1001, 10), "teto configurado em 1000", "creator_asset_dimensions");
        Assert.True(GateFc2.Ok((await GateFc2.UploadAsync(client, storage, business, "template", "image/png", GateFc2.Png(1000, 10))).Status));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Jpeg_is_stored_without_exif_gps_or_data_after_the_end_of_image()
    {
        var (factory, storage, client, business) = await SetupAsync();
        await using var _ = factory;
        var original = GateFc2.Jpeg(120, 90, exif: true, trailer: true);
        Assert.Contains("SECRET", Encoding.Latin1.GetString(original));
        var (id, status, body) = await GateFc2.UploadAsync(client, storage, business, "template", "image/jpeg", original);
        Assert.True(GateFc2.Ok(status), $"HTTP {status} {body}");
        var stored = storage.FinalWrites.Single().Bytes;
        var text = Encoding.Latin1.GetString(stored);
        Assert.DoesNotContain("SECRET", text);
        Assert.DoesNotContain("Exif", text);
        Assert.DoesNotContain("GPS", text);
        Assert.False(Enumerable.Range(0, stored.Length - 1).Any(i => stored[i] == 0xFF && stored[i + 1] == 0xE1), "segmento APP1 ainda presente");
        Assert.Equal([(byte)0xFF, (byte)0xD9], stored[^2..]);
        Assert.Equal((120, 90), (int.Parse((await AssetRowAsync(id))[2]), int.Parse((await AssetRowAsync(id))[3])));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Complete_is_idempotent_and_rejects_bytes_larger_than_declared()
    {
        var (factory, storage, client, business) = await SetupAsync();
        await using var _ = factory;
        var bytes = GateFc2.Png(50, 50);
        var upload = await GateFc2.RequestUploadAsync(client, business, "template", "image/png", bytes.Length);
        var id = Guid.Parse(upload.Body.GetProperty("assetId").GetString()!);
        storage.Put(id, "image/png", bytes);
        var first = await GateFc2.CallAsync(client, HttpMethod.Post, GateFc2.Route(business, $"/assets/{id}/complete"));
        var second = await GateFc2.CallAsync(client, HttpMethod.Post, GateFc2.Route(business, $"/assets/{id}/complete"));
        Assert.True(GateFc2.Ok(first.Status) && GateFc2.Ok(second.Status), $"{first.Status}/{second.Status}");
        Assert.Equal(1, storage.FinalWrites.Count());

        var small = await GateFc2.RequestUploadAsync(client, business, "template", "image/png", 100);
        var smallId = Guid.Parse(small.Body.GetProperty("assetId").GetString()!);
        storage.Put(smallId, "image/png", GateFc2.Png(20, 20).Concat(new byte[500]).ToArray());
        var oversize = await GateFc2.CallAsync(client, HttpMethod.Post, GateFc2.Route(business, $"/assets/{smallId}/complete"));
        Assert.Contains(oversize.Status, new[] { 409, 413 });
        Assert.NotEqual("ready", (await AssetRowAsync(smallId))[0]);
        Assert.False(storage.Objects.ContainsKey(storage.UploadSigns.Last().Path), "staging do arquivo maior que o declarado deve ser apagado");
        var neverUploaded = await GateFc2.RequestUploadAsync(client, business, "template", "image/png", 100);
        var ghost = Guid.Parse(neverUploaded.Body.GetProperty("assetId").GetString()!);
        var missing = await GateFc2.CallAsync(client, HttpMethod.Post, GateFc2.Route(business, $"/assets/{ghost}/complete"));
        Assert.False(GateFc2.Ok(missing.Status), "complete sem objeto no storage não pode virar ready");
        Assert.NotEqual("ready", (await AssetRowAsync(ghost))[0]);
    }

    // ───────────────────────── SVG ─────────────────────────

    private static readonly (string Why, string Svg)[] Rejected =
    [
        ("script", GateFc2.Svg("<script>alert(1)</script><rect width=\"10\" height=\"10\"/>")),
        ("atributo onload", GateFc2.SvgOpen.Replace("<svg ", "<svg onload=\"alert(1)\" ") + "<rect width=\"1\" height=\"1\"/></svg>"),
        ("atributo onclick", GateFc2.Svg("<rect width=\"10\" height=\"10\" onclick=\"alert(1)\"/>")),
        ("foreignObject", GateFc2.Svg("<foreignObject width=\"10\" height=\"10\"><div xmlns=\"http://www.w3.org/1999/xhtml\">x</div></foreignObject>")),
        ("DOCTYPE com entidade", "<?xml version=\"1.0\"?><!DOCTYPE svg [<!ENTITY x \"y\">]>" + GateFc2.Svg("<text>&x;</text>")),
        ("billion laughs", "<?xml version=\"1.0\"?><!DOCTYPE lolz [<!ENTITY lol \"lol\"><!ENTITY lol2 \"&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;\"><!ENTITY lol3 \"&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;\">]>" + GateFc2.Svg("<text>&lol3;</text>")),
        ("xlink:href remoto", GateFc2.Svg("<use xlink:href=\"http://evil.test/a.svg#x\"/>")),
        ("href remoto", GateFc2.Svg("<use href=\"https://evil.test/a.svg#x\"/>")),
        ("javascript:", GateFc2.Svg("<path d=\"M0 0\" fill=\"javascript:alert(1)\"/>")),
        ("CSS @import", GateFc2.Svg("<style>@import url(http://evil.test/x.css);</style><rect width=\"1\" height=\"1\"/>")),
        ("url() remoto", GateFc2.Svg("<rect width=\"10\" height=\"10\" fill=\"url(http://evil.test/x)\"/>")),
        ("expression()", GateFc2.Svg("<rect width=\"10\" height=\"10\" style=\"width:expression(alert(1))\"/>")),
        ("elemento image", GateFc2.Svg("<image href=\"#a\" width=\"10\" height=\"10\"/>")),
        ("image com data:", GateFc2.Svg("<image href=\"data:image/png;base64,AAAA\" width=\"10\" height=\"10\"/>")),
        ("data: em atributo", GateFc2.Svg("<rect width=\"10\" height=\"10\" fill=\"data:text/html;base64,AAAA\"/>")),
        ("animate", GateFc2.Svg("<rect width=\"10\" height=\"10\"><animate attributeName=\"x\" from=\"0\" to=\"10\" dur=\"1s\"/></rect>")),
        ("set", GateFc2.Svg("<rect width=\"10\" height=\"10\"><set attributeName=\"fill\" to=\"red\"/></rect>")),
    ];

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Active_svg_content_is_rejected_whole_with_creator_svg_rejected()
    {
        var (factory, storage, client, business) = await SetupAsync();
        await using var _ = factory;
        foreach (var (why, svg) in Rejected)
        {
            var (id, status, body) = await GateFc2.UploadAsync(client, storage, business, "template", "image/svg+xml", GateFc2.Utf8(svg));
            Assert.True(status == 422, $"{why}: esperava 422, veio {status} {body}");
            Assert.True(GateFc.Code(body) == "creator_svg_rejected", $"{why}: code {GateFc.Code(body)}");
            Assert.True(body.TryGetProperty("reason", out var reason) && reason.GetString()!.Length > 0, $"{why}: sem reason");
            Assert.Matches("[Ss][Vv][Gg]", body.GetProperty("detail").GetString()!);
            Assert.NotEqual("ready", (await AssetRowAsync(id))[0]);
        }
        Assert.Empty(storage.FinalWrites);
        Assert.False(storage.Objects.Keys.Any(p => p.StartsWith("staging/", StringComparison.Ordinal)), "staging de SVG recusado deve ser apagado");
        Assert.Equal(0, int.Parse(await GateFc2.ScalarAsync($"SELECT count(*) FROM fluxo.creator_assets WHERE business_id = '{business}' AND status = 'ready'") ?? "-1"));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Oversized_or_too_deep_svg_is_rejected_and_the_limits_come_from_configuration()
    {
        var (factory, storage, client, business) = await SetupAsync((GateFc.KeyOf("SvgMaxNodes"), "20"), (GateFc.KeyOf("SvgMaxDepth"), "5"), (GateFc.KeyOf("SvgMaxBytes"), "2000"));
        await using var _ = factory;
        var many = GateFc2.Svg(string.Concat(Enumerable.Repeat("<rect width=\"1\" height=\"1\"/>", 25)));
        var deep = GateFc2.Svg(string.Concat(Enumerable.Repeat("<g>", 8)) + "<rect width=\"1\" height=\"1\"/>" + string.Concat(Enumerable.Repeat("</g>", 8)));
        var heavy = GateFc2.Svg("<text>" + new string('x', 3000) + "</text>");
        foreach (var (why, svg) in new[] { ("nós demais", many), ("profundo demais", deep), ("bytes demais", heavy) })
        {
            var upload = await GateFc2.RequestUploadAsync(client, business, "template", "image/svg+xml", Encoding.UTF8.GetByteCount(svg));
            if (!GateFc2.Ok(upload.Status)) { Assert.Contains(upload.Status, new[] { 413, 422 }); continue; }
            var id = Guid.Parse(upload.Body.GetProperty("assetId").GetString()!);
            storage.Put(id, "image/svg+xml", GateFc2.Utf8(svg));
            var done = await GateFc2.CallAsync(client, HttpMethod.Post, GateFc2.Route(business, $"/assets/{id}/complete"));
            Assert.True(done.Status is 413 or 422, $"{why}: HTTP {done.Status}");
            Assert.NotEqual("ready", (await AssetRowAsync(id))[0]);
        }
        Assert.Empty(storage.FinalWrites);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Legit_logo_is_approved_and_reserialized_without_what_was_removed()
    {
        var (factory, storage, client, business) = await SetupAsync();
        await using var _ = factory;
        var logo = GateFc2.Svg(
            "<defs><linearGradient id=\"g\"><stop offset=\"0\" stop-color=\"#f00\"/><stop offset=\"1\" stop-color=\"#00f\"/></linearGradient></defs>" +
            "<title>Logo</title><metadata>segredo-do-editor</metadata>" +
            "<g data-secret=\"abc\" fill=\"#123456\"><circle cx=\"50\" cy=\"50\" r=\"40\" fill=\"url(#g)\" data-internal=\"x\"/><path d=\"M10 10L90 90\" stroke=\"#000\"/>" +
            "<text x=\"10\" y=\"95\" font-size=\"8\">Fluxo</text></g><use href=\"#g\"/>");
        var original = GateFc2.Utf8(logo);
        var (id, status, body) = await GateFc2.UploadAsync(client, storage, business, "template", "image/svg+xml", original);
        Assert.True(GateFc2.Ok(status), $"logo legítimo recusado: HTTP {status} {body}");
        var written = storage.FinalWrites.Single();
        Assert.Equal("image/svg+xml", written.ContentType);
        Assert.NotEqual(original, written.Bytes);
        var text = Encoding.UTF8.GetString(written.Bytes);
        Assert.DoesNotContain("segredo-do-editor", text);
        Assert.DoesNotContain("data-secret", text);
        Assert.DoesNotContain("data-internal", text);
        var xml = XDocument.Parse(text);
        var names = xml.Descendants().Select(e => e.Name.LocalName).ToArray();
        Assert.Contains("circle", names);
        Assert.Contains("linearGradient", names);
        Assert.Contains("text", names);
        Assert.DoesNotContain("metadata", names);
        Assert.Equal("Fluxo", xml.Descendants().Single(e => e.Name.LocalName == "text").Value);
        Assert.Equal("ready", (await AssetRowAsync(id))[0]);
        Assert.Equal("svg", (await AssetRowAsync(id))[1]);
    }
}
