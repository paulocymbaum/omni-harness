// Gates FC-002-CONTRASTE e FC-002-PALETA-API (template). Tudo por HTTP em PUT/GET /api/v1/creator/brand-kit/palette (sem storage).
// Formato lido pelo gate (a spec descreve os campos): palette = { colors: [{ role, <hex #RRGGBB> }], pairs: [{ ratio, level, suggestion? }],
// accent: { ratios: [{ ratio }] } | null, version }; a resposta do PUT traz a paleta calculada (com ou sem o invólucro "palette").
// Os pares vêm na ordem bg1xtext1, bg2xtext2. Extensões de erro (ex.: pairs) são campos do Problem Details.
using System.Text.Json;

namespace Fluxo.Api.Tests;

public sealed class GateFc002PaletteTests
{
    // Gate corrigido: PermitLimit 100000 derrubava a subida da API (a validação aceita 1..10000); 10000 é o maior valor válido.
    private static DebateApiFactory Api() => new(GateFc.C, settings: GateFc.Settings(("RateLimiting:PermitLimit", "10000")));

    private static async Task<(DebateApiFactory Factory, HttpClient Client, string Business)> SetupAsync()
    {
        var (id, owner) = await GateFc.SeedBusinessAsync();
        var factory = Api();
        return (factory, factory.Client($"user:{owner}"), id);
    }

    private static Task<(int Status, JsonElement Body, HttpResponseMessage Raw)> PutAsync(HttpClient client, string business, string[] colors, bool? confirm = null) =>
        GateFc2.CallAsync(client, HttpMethod.Put, GateFc2.Route(business, "/palette"), confirm is null ? new { colors } : new { colors, confirmLowContrast = confirm });

    private static JsonElement Palette(JsonElement body) => body.TryGetProperty("palette", out var inner) ? inner : body;
    private static JsonElement[] Pairs(JsonElement palette) => palette.GetProperty("pairs").EnumerateArray().ToArray();
    private static string[] Roles(JsonElement palette) => palette.GetProperty("colors").EnumerateArray().Select(c => c.GetProperty("role").GetString()!).ToArray();
    private static string[] Hexes(JsonElement palette) => palette.GetProperty("colors").EnumerateArray().Select(GateFc2.Hex).ToArray();

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Contrast_vectors_follow_wcag_with_two_decimal_truncation_and_the_thresholds()
    {
        var (factory, client, business) = await SetupAsync();
        await using var _ = factory;
        var vectors = new (string Bg, string Text, double Ratio, string Level)[]
        {
            ("#FFFFFF", "#000000", 21.00, "good"), ("#000000", "#FFFFFF", 21.00, "good"), ("#FFFFFF", "#767676", 4.54, "good"),
            ("#FFFFFF", "#777777", 4.47, "warning"), ("#FFFFFF", "#007EB7", 4.49, "warning"), ("#FFFFFF", "#949494", 3.03, "warning"),
            ("#FFFFFF", "#0099FF", 2.99, "needs_confirmation"), ("#FFFFFF", "#CCCCCC", 1.60, "needs_confirmation"), ("#336699", "#336699", 1.00, "needs_confirmation"),
        };
        foreach (var (bg, text, ratio, level) in vectors)
        {
            var result = await PutAsync(client, business, [bg, text], confirm: true);
            Assert.True(result.Status == 200, $"{bg} x {text}: HTTP {result.Status} {result.Body}");
            var pair = Pairs(Palette(result.Body)).Single();
            Assert.True(Math.Abs(pair.GetProperty("ratio").GetDouble() - ratio) < 0.0001, $"{bg} x {text}: ratio {pair.GetProperty("ratio").GetDouble()} em vez de {ratio} (truncado, nunca arredondado)");
            Assert.Equal(level, pair.GetProperty("level").GetString());
        }
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Roles_follow_the_color_count_and_the_accent_of_four_colors_is_the_text_of_pair_one()
    {
        var (factory, client, business) = await SetupAsync();
        await using var _ = factory;
        string[] all = ["#FFFFFF", "#111111", "#EEEEEE", "#222222", "#B02A00"];
        var expected = new Dictionary<int, string[]>
        {
            [2] = ["bg1", "text1"], [3] = ["bg1", "text1", "accent"], [4] = ["bg1", "text1", "bg2", "text2"], [5] = ["bg1", "text1", "bg2", "text2", "accent"],
        };
        foreach (var (count, roles) in expected)
        {
            var colors = count == 3 ? new[] { "#FFFFFF", "#111111", "#B02A00" } : all.Take(count).ToArray();
            var result = await PutAsync(client, business, colors);
            Assert.True(result.Status == 200, $"{count} cores: HTTP {result.Status} {result.Body}");
            var palette = Palette(result.Body);
            Assert.Equal(roles, Roles(palette));
            Assert.Equal(count >= 4 ? 2 : 1, Pairs(palette).Length);
            if (count == 2) Assert.True(!palette.TryGetProperty("accent", out var none) || none.ValueKind == JsonValueKind.Null, "com 2 cores não há destaque");
            if (count == 4) Assert.Equal(colors[1], GateFc2.Hex(palette.GetProperty("accent")));
            if (count == 3) Assert.Equal(colors[2], GateFc2.Hex(palette.GetProperty("accent")));
            if (count == 5) Assert.Equal(colors[4], GateFc2.Hex(palette.GetProperty("accent")));
        }
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Suggestion_reaches_the_good_level_by_changing_only_the_text_color()
    {
        var (factory, client, business) = await SetupAsync();
        await using var _ = factory;
        foreach (var (bg, text) in new[] { ("#FFFFFF", "#777777"), ("#FFFFFF", "#CCCCCC"), ("#000000", "#333333"), ("#0057B8", "#3A7BD5") })
        {
            var result = await PutAsync(client, business, [bg, text], confirm: true);
            Assert.Equal(200, result.Status);
            var palette = Palette(result.Body);
            Assert.Equal([bg, text], Hexes(palette));
            var pair = Pairs(palette).Single();
            Assert.True(pair.TryGetProperty("suggestion", out var suggestion) && suggestion.ValueKind != JsonValueKind.Null, $"{bg} x {text} sem suggestion");
            var fix = GateFc2.Hex(suggestion);
            Assert.True(GateFc2.Ratio(fix, bg) >= 4.5, $"{bg} x {text}: sugestão {fix} dá {GateFc2.Ratio(fix, bg):0.00}");
            var away = GateFc2.Luminance(bg) > 0.5 ? GateFc2.Luminance(fix) < GateFc2.Luminance(text) : GateFc2.Luminance(fix) > GateFc2.Luminance(text);
            Assert.True(away, $"{bg} x {text}: a sugestão {fix} deve afastar o texto do fundo");
        }
        var good = Pairs(Palette((await PutAsync(client, business, ["#FFFFFF", "#000000"])).Body)).Single();
        Assert.True(!good.TryGetProperty("suggestion", out var none) || none.ValueKind == JsonValueKind.Null, "par bom não tem sugestão");
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Accent_contrast_is_informational_and_never_blocks_the_save()
    {
        var (factory, client, business) = await SetupAsync();
        await using var _ = factory;
        var three = await PutAsync(client, business, ["#FFFFFF", "#111111", "#FFFFE0"]);
        Assert.True(three.Status == 200, $"destaque fraco bloqueou o salvamento: HTTP {three.Status} {three.Body}");
        var ratios3 = Palette(three.Body).GetProperty("accent").GetProperty("ratios").EnumerateArray().ToArray();
        Assert.Single(ratios3);
        Assert.True(ratios3[0].GetProperty("ratio").GetDouble() < 1.2);
        var five = await PutAsync(client, business, ["#FFFFFF", "#111111", "#EEEEEE", "#222222", "#FFFFE0"]);
        Assert.Equal(200, five.Status);
        Assert.Equal(2, Palette(five.Body).GetProperty("accent").GetProperty("ratios").GetArrayLength());
        var four = await PutAsync(client, business, ["#FFFFFF", "#111111", "#EEEEEE", "#222222"]);
        Assert.Equal(200, four.Status);
        Assert.Equal(2, Palette(four.Body).GetProperty("accent").GetProperty("ratios").GetArrayLength());
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Wrong_color_count_and_invalid_hex_give_422_creator_palette_invalid()
    {
        var (factory, client, business) = await SetupAsync();
        await using var _ = factory;
        var attempts = new[]
        {
            new[] { "#FFFFFF" }, new[] { "#111111", "#222222", "#333333", "#444444", "#555555", "#666666" }, Array.Empty<string>(),
            new[] { "#12345", "#FFFFFF" }, new[] { "#GGGGGG", "#FFFFFF" }, new[] { "red", "blue" }, new[] { "123456", "654321" }, new[] { "#FFFFFFF", "#000000" },
        };
        foreach (var colors in attempts)
        {
            var result = await PutAsync(client, business, colors, confirm: true);
            Assert.True(result.Status == 422, $"[{string.Join(",", colors)}]: HTTP {result.Status}");
            Assert.Equal("creator_palette_invalid", GateFc.Code(result.Body));
        }
        var ok = await PutAsync(client, business, ["#FFFFFF", "#000000"]);
        Assert.Equal(200, ok.Status);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Hex_is_normalized_to_uppercase_rrggbb()
    {
        var (factory, client, business) = await SetupAsync();
        await using var _ = factory;
        var result = await PutAsync(client, business, ["#ffffff", "#0a0a0a"]);
        Assert.Equal(200, result.Status);
        Assert.Equal(["#FFFFFF", "#0A0A0A"], Hexes(Palette(result.Body)));
        var read = await GateFc2.CallAsync(client, HttpMethod.Get, GateFc2.Route(business, ""));
        Assert.Equal(["#FFFFFF", "#0A0A0A"], Hexes(read.Body.GetProperty("palette")));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Pair_under_three_to_one_needs_confirmation_and_warning_does_not()
    {
        var (factory, client, business) = await SetupAsync();
        await using var _ = factory;
        var blocked = await PutAsync(client, business, ["#FFFFFF", "#CCCCCC"]);
        Assert.Equal(422, blocked.Status);
        Assert.Equal("creator_palette_low_contrast", GateFc.Code(blocked.Body));
        var listed = blocked.Body.GetProperty("pairs").EnumerateArray().ToArray();
        Assert.Single(listed);
        Assert.True(Math.Abs(listed[0].GetProperty("ratio").GetDouble() - 1.60) < 0.0001);
        var second = await PutAsync(client, business, ["#FFFFFF", "#111111", "#EEEEEE", "#E0E0E0"]);
        Assert.Equal(422, second.Status);
        Assert.Equal("creator_palette_low_contrast", GateFc.Code(second.Body));
        Assert.Equal(200, (await PutAsync(client, business, ["#FFFFFF", "#CCCCCC"], confirm: true)).Status);
        Assert.Equal(200, (await PutAsync(client, business, ["#FFFFFF", "#777777"])).Status);
        Assert.Equal(422, (await PutAsync(client, business, ["#FFFFFF", "#0099FF"], confirm: false)).Status);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Get_returns_the_calculated_palette_and_every_write_bumps_the_version()
    {
        var (factory, client, business) = await SetupAsync();
        await using var _ = factory;
        var first = await GateFc2.CallAsync(client, HttpMethod.Get, GateFc2.Route(business, ""));
        Assert.Equal(200, first.Status);
        var before = first.Body.GetProperty("palette").GetProperty("version").GetInt32();
        Assert.Equal(200, (await PutAsync(client, business, ["#FFFFFF", "#111111", "#B02A00"])).Status);
        var afterOne = await GateFc2.CallAsync(client, HttpMethod.Get, GateFc2.Route(business, ""));
        var palette = afterOne.Body.GetProperty("palette");
        Assert.Equal(before + 1, palette.GetProperty("version").GetInt32());
        Assert.Equal(["bg1", "text1", "accent"], Roles(palette));
        Assert.Single(Pairs(palette));
        Assert.Equal(200, (await PutAsync(client, business, ["#FFFFFF", "#000000"])).Status);
        var afterTwo = await GateFc2.CallAsync(client, HttpMethod.Get, GateFc2.Route(business, ""));
        Assert.Equal(before + 2, afterTwo.Body.GetProperty("palette").GetProperty("version").GetInt32());
        var raw = afterTwo.Body.GetRawText();
        Assert.DoesNotContain("createdByUid", raw);
        Assert.DoesNotContain("updatedByUid", raw);
    }
}
