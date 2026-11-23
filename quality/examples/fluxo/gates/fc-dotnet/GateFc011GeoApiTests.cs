// Gates FC-011 (template): GEO-BUSCA, GEO-PAGINACAO, GEO-API, LIMITES-CONFIG, RATE-LIMIT e SEM-SECAO-ELEITORAL.
// Só HTTP: compila antes da implementação e falha em execução. O dataset vem embarcado no assembly (sem rede nem BigQuery).
// Vale a regra de busca da spec: o texto digitado é normalizado (NFD sem marcas, minúsculo, hífen e apóstrofo viram espaço)
// e casa no INÍCIO de uma palavra do nome normalizado; consulta de várias palavras casa a sequência a partir do início de uma palavra.
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace Fluxo.Api.Tests;

public sealed class GateFc011GeoApiTests
{
    // Gate corrigido (decisão D): PermitLimit 100000 derrubava a subida da API (a validação aceita 1..10000); 10000 é o maior valor válido.
    private static readonly (string, string?)[] Roomy =
    [
        ("RateLimiting:PermitLimit", "10000"), ("RateLimiting:Creator:Geo:TokensPerSecond", "1000"),
        ("RateLimiting:Creator:Geo:BurstTokens", "1000"), ("RateLimiting:Creator:Geo:QueueLimit", "0"),
    ];

    private static DebateApiFactory Api(params (string Key, string? Value)[] extra) => new(GateFc.C, settings: GateFc.Settings(extra));
    private static HttpClient User(DebateApiFactory factory, string? uid = null) => factory.Client($"user:{uid ?? $"geo-{Guid.NewGuid():N}"}");

    private static string Norm(string value)
    {
        var decomposed = value.Normalize(NormalizationForm.FormD);
        var sb = new StringBuilder();
        foreach (var ch in decomposed)
        {
            if (CharUnicodeInfo.GetUnicodeCategory(ch) == UnicodeCategory.NonSpacingMark) continue;
            sb.Append(ch is '-' or '\'' or '’' ? ' ' : char.ToLowerInvariant(ch));
        }
        return string.Join(' ', sb.ToString().Split(' ', StringSplitOptions.RemoveEmptyEntries));
    }

    private static bool MatchesWordPrefix(string name, string q)
    {
        var key = " " + Norm(name);
        return key.Contains(" " + Norm(q), StringComparison.Ordinal);
    }

    private static JsonElement[] Items(JsonElement body) => body.GetProperty("items").EnumerateArray().ToArray();
    private static string[] Names(JsonElement body) => Items(body).Select(i => i.GetProperty("name").GetString()!).ToArray();
    private static string[] Ibges(JsonElement body) => Items(body).Select(i => i.GetProperty("ibge").GetString()!).ToArray();

    private static string Cities(string uf, string? q = null, string? cursor = null, string? limit = null)
    {
        var parts = new List<string> { $"uf={Uri.EscapeDataString(uf)}" };
        if (q is not null) parts.Add($"q={Uri.EscapeDataString(q)}");
        if (cursor is not null) parts.Add($"cursor={Uri.EscapeDataString(cursor)}");
        if (limit is not null) parts.Add($"limit={limit}");
        return "/api/v1/creator/geo/municipios?" + string.Join('&', parts);
    }

    // ───────────────────────── GEO-BUSCA ─────────────────────────

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Search_matches_word_prefix_without_accents_or_case()
    {
        await using var factory = Api(Roomy);
        using var client = User(factory);
        var divino = await GateFc.GetAsync(client, Cities("MG", "divino"));
        Assert.Equal(200, divino.Status);
        var names = Names(divino.Body);
        Assert.Contains("Divinópolis", names);
        Assert.Contains("Divino", names);
        Assert.Contains("São José do Divino", names);
        Assert.DoesNotContain("Divinésia", names);
        Assert.All(names, n => Assert.True(MatchesWordPrefix(n, "divino"), $"'{n}' não casa com 'divino'"));

        var accented = await GateFc.GetAsync(client, Cities("MG", "DIVINÓPOLIS"));
        var plain = await GateFc.GetAsync(client, Cities("MG", "divinopolis"));
        Assert.Equal(Ibges(accented.Body), Ibges(plain.Body));
        Assert.Contains("3122306", Ibges(plain.Body));

        var lower = await GateFc.GetAsync(client, Cities("mg", "divino"));
        Assert.Equal(Ibges(divino.Body), Ibges(lower.Body));

        var item = Items(plain.Body).Single(i => i.GetProperty("ibge").GetString() == "3122306");
        Assert.Equal("MG", item.GetProperty("uf").GetString());
        Assert.Equal("Divinópolis", item.GetProperty("name").GetString());
        var porte = item.GetProperty("porte");
        Assert.Equal("ate500", porte.GetProperty("id").GetString());
        Assert.Equal("de 100 a 500 mil hab.", porte.GetProperty("label").GetString());
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Search_handles_apostrophe_hyphen_and_title_case()
    {
        await using var factory = Api(Roomy);
        using var client = User(factory);
        foreach (var q in new[] { "olho d agua", "d'agua", "OLHO D'ÁGUA" })
        {
            var result = await GateFc.GetAsync(client, Cities("AL", q));
            Assert.Equal(200, result.Status);
            var names = Names(result.Body);
            Assert.Contains("Olho d'Água das Flores", names);
            Assert.Contains("Olho d'Água do Casado", names);
            Assert.Contains("Olho d'Água Grande", names);
        }
        var xique = await GateFc.GetAsync(client, Cities("BA", "xique"));
        Assert.Contains("Xique-Xique", Names(xique.Body));
        var joao = await GateFc.GetAsync(client, Cities("GO", "sao joao d"));
        Assert.Contains("São João d'Aliança", Names(joao.Body));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Ufs_are_matched_by_name_or_initials_and_never_paginate()
    {
        await using var factory = Api(Roomy);
        using var client = User(factory);
        var all = await GateFc.GetAsync(client, "/api/v1/creator/geo/ufs");
        Assert.Equal(200, all.Status);
        Assert.Equal(27, Items(all.Body).Length);
        Assert.Equal(JsonValueKind.Null, all.Body.GetProperty("nextCursor").ValueKind);
        var codes = Items(all.Body).ToDictionary(i => i.GetProperty("uf").GetString()!, i => (i.GetProperty("code").GetString()!, i.GetProperty("name").GetString()!));
        Assert.Equal(("31", "Minas Gerais"), codes["MG"]);
        Assert.Equal(("53", "Distrito Federal"), codes["DF"]);
        Assert.False(codes.ContainsKey("ZZ"));
        var ordered = Items(all.Body).Select(i => Norm(i.GetProperty("name").GetString()!)).ToArray();
        Assert.Equal(ordered.Order(StringComparer.Ordinal).ToArray(), ordered);

        foreach (var q in new[] { "mi", "minas", "MG", "mg" })
        {
            var found = await GateFc.GetAsync(client, $"/api/v1/creator/geo/ufs?q={Uri.EscapeDataString(q)}");
            Assert.Equal(200, found.Status);
            Assert.Contains("MG", Items(found.Body).Select(i => i.GetProperty("uf").GetString()));
            Assert.Equal(JsonValueKind.Null, found.Body.GetProperty("nextCursor").ValueKind);
        }
        var mi = await GateFc.GetAsync(client, "/api/v1/creator/geo/ufs?q=mi");
        Assert.DoesNotContain("SP", Items(mi.Body).Select(i => i.GetProperty("uf").GetString()));
    }

    // ───────────────────────── GEO-PAGINACAO ─────────────────────────

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Cursor_walk_over_a_state_has_no_repeat_and_no_skip()
    {
        await using var factory = Api(Roomy);
        using var client = User(factory);
        var seen = new List<string>();
        var keys = new List<(string Key, string Ibge)>();
        string? cursor = null;
        var pages = 0;
        do
        {
            var page = await GateFc.GetAsync(client, Cities("MG", cursor: cursor));
            Assert.Equal(200, page.Status);
            var items = Items(page.Body);
            Assert.InRange(items.Length, 1, 15);
            if (page.Body.GetProperty("nextCursor").ValueKind != JsonValueKind.Null) Assert.Equal(15, items.Length);
            foreach (var item in items)
            {
                seen.Add(item.GetProperty("ibge").GetString()!);
                keys.Add((Norm(item.GetProperty("name").GetString()!), item.GetProperty("ibge").GetString()!));
            }
            cursor = page.Body.GetProperty("nextCursor").ValueKind == JsonValueKind.Null ? null : page.Body.GetProperty("nextCursor").GetString();
            pages++;
            Assert.True(pages <= 70, "cursor não termina");
        } while (cursor is not null);
        Assert.Equal(853, seen.Count);
        Assert.Equal(853, seen.Distinct().Count());
        Assert.Equal(57, pages);
        Assert.Equal(keys.OrderBy(k => k.Key, StringComparer.Ordinal).ThenBy(k => k.Ibge, StringComparer.Ordinal).ToArray(), keys.ToArray());
        Assert.All(seen, ibge => Assert.StartsWith("31", ibge));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Cursor_is_opaque_keyset_over_key_and_ibge_of_the_last_item()
    {
        await using var factory = Api(Roomy);
        using var client = User(factory);
        var first = await GateFc.GetAsync(client, Cities("MG"));
        var cursor = first.Body.GetProperty("nextCursor").GetString()!;
        Assert.Matches("^[A-Za-z0-9_-]+$", cursor);
        var padded = cursor.Replace('-', '+').Replace('_', '/');
        padded = padded.PadRight(padded.Length + (4 - padded.Length % 4) % 4, '=');
        var parts = Encoding.UTF8.GetString(Convert.FromBase64String(padded)).Split('|');
        Assert.Equal(4, parts.Length);
        Assert.Equal("v1", parts[0]);
        var last = Items(first.Body).Last();
        Assert.Equal(Norm(last.GetProperty("name").GetString()!), parts[1]);
        Assert.Equal(last.GetProperty("ibge").GetString(), parts[2]);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Limit_above_page_size_is_rejected_and_not_truncated()
    {
        await using var factory = Api(Roomy);
        using var client = User(factory);
        foreach (var bad in new[] { "16", "0", "-1", "100" })
        {
            var result = await GateFc.GetAsync(client, Cities("MG", limit: bad));
            Assert.Equal(422, result.Status);
            Assert.Equal("creator_geo_limit_invalid", GateFc.Code(result.Body));
        }
        var five = await GateFc.GetAsync(client, Cities("MG", limit: "5"));
        Assert.Equal(200, five.Status);
        Assert.Equal(5, Items(five.Body).Length);
        var fifteen = await GateFc.GetAsync(client, Cities("MG", limit: "15"));
        Assert.Equal(15, Items(fifteen.Body).Length);
        var omitted = await GateFc.GetAsync(client, Cities("MG"));
        Assert.Equal(15, Items(omitted.Body).Length);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Tampered_or_foreign_cursor_is_rejected()
    {
        await using var factory = Api(Roomy);
        using var client = User(factory);
        var first = await GateFc.GetAsync(client, Cities("MG", "sao"));
        var cursor = first.Body.GetProperty("nextCursor").GetString()!;
        Assert.Equal(200, (await GateFc.GetAsync(client, Cities("MG", "sao", cursor))).Status);
        Assert.Equal(200, (await GateFc.GetAsync(client, Cities("MG", "SÃO", cursor))).Status);
        var tampered = cursor[..^3] + (cursor[^3] == 'A' ? "BBB" : "AAA");
        var attempts = new[]
        {
            Cities("MG", "sao", "isto-nao-e-um-cursor"), Cities("MG", "sao", tampered), Cities("SP", "sao", cursor), Cities("MG", "pedra", cursor), Cities("MG", null, cursor),
        };
        foreach (var route in attempts)
        {
            var result = await GateFc.GetAsync(client, route);
            Assert.Equal(422, result.Status);
            Assert.Equal("creator_geo_cursor_invalid", GateFc.Code(result.Body));
        }
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task State_is_required_valid_and_the_query_has_a_ceiling()
    {
        await using var factory = Api(Roomy);
        using var client = User(factory);
        var missing = await GateFc.GetAsync(client, "/api/v1/creator/geo/municipios?q=a");
        Assert.Equal(422, missing.Status);
        Assert.Equal("creator_geo_uf_required", GateFc.Code(missing.Body));
        var bad = await GateFc.GetAsync(client, Cities("XX"));
        Assert.Equal(422, bad.Status);
        Assert.Equal("creator_geo_uf_invalid", GateFc.Code(bad.Body));
        var edge = await GateFc.GetAsync(client, Cities("MG", new string('a', 60)));
        Assert.Equal(200, edge.Status);
        var tooLong = await GateFc.GetAsync(client, Cities("MG", new string('a', 61)));
        Assert.Equal(422, tooLong.Status);
        Assert.Equal("creator_geo_query_too_long", GateFc.Code(tooLong.Body));
    }

    // ───────────────────────── GEO-API ─────────────────────────

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Anonymous_gets_401_and_disabled_feature_gets_404()
    {
        await using var factory = Api(Roomy);
        using var anonymous = factory.CreateClient();
        foreach (var route in new[] { "/api/v1/creator/geo/ufs", "/api/v1/creator/geo/municipios?uf=MG" })
        {
            var denied = await GateFc.GetAsync(anonymous, route);
            Assert.Equal(401, denied.Status);
            Assert.Equal("firebase_id_token_required", GateFc.Code(denied.Body));
        }
        await using var off = Api(Roomy.Append(("Creator:Enabled", "false")).ToArray());
        using var client = User(off);
        foreach (var route in new[] { "/api/v1/creator/geo/ufs", "/api/v1/creator/geo/municipios?uf=MG" })
        {
            var hidden = await GateFc.GetAsync(client, route);
            Assert.Equal(404, hidden.Status);
            Assert.Equal("creator_disabled", GateFc.Code(hidden.Body));
        }
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Success_is_public_cacheable_with_a_strong_etag_and_304_on_match()
    {
        await using var factory = Api(Roomy);
        using var client = User(factory);
        foreach (var route in new[] { "/api/v1/creator/geo/ufs", Cities("MG", "divino") })
        {
            var ok = await GateFc.GetAsync(client, route);
            Assert.Equal(200, ok.Status);
            var cache = ok.Raw.Headers.CacheControl;
            Assert.True(cache is { Public: true }, $"Cache-Control sem public em {route}: {cache}");
            Assert.Equal(TimeSpan.FromSeconds(86400), cache!.MaxAge);
            var etag = ok.Raw.Headers.ETag;
            Assert.True(etag is { IsWeak: false }, $"ETag ausente ou fraco em {route}");

            using var conditional = new HttpRequestMessage(HttpMethod.Get, route);
            conditional.Headers.IfNoneMatch.Add(etag!);
            using var response = await client.SendAsync(conditional);
            Assert.Equal(HttpStatusCode.NotModified, response.StatusCode);
            Assert.Equal(0, (await response.Content.ReadAsByteArrayAsync()).Length);

            using var stale = new HttpRequestMessage(HttpMethod.Get, route);
            stale.Headers.IfNoneMatch.Add(new EntityTagHeaderValue("\"outro\""));
            using var full = await client.SendAsync(stale);
            Assert.Equal(HttpStatusCode.OK, full.StatusCode);
        }
        var a = await GateFc.GetAsync(client, Cities("MG", "divino"));
        var b = await GateFc.GetAsync(client, Cities("MG", "sao"));
        Assert.NotEqual(a.Raw.Headers.ETag!.Tag, b.Raw.Headers.ETag!.Tag);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Error_responses_never_carry_public_cache()
    {
        await using var factory = Api(Roomy);
        using var client = User(factory);
        var error = await GateFc.GetAsync(client, Cities("MG", limit: "16"));
        Assert.Equal(422, error.Status);
        Assert.NotEqual(true, error.Raw.Headers.CacheControl?.Public);
        var missing = await GateFc.GetAsync(client, "/api/v1/creator/geo/municipios");
        Assert.Equal(422, missing.Status);
        Assert.NotEqual(true, missing.Raw.Headers.CacheControl?.Public);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Payload_has_no_document_identity_candidate_or_electoral_fields()
    {
        await using var factory = Api(Roomy);
        using var client = User(factory);
        var forbidden = new[] { "cpf", "cnpj", "email", "document", "uid", "lula", "bolsonaro", "leader", "aptos", "zona", "zone", "secao", "section", "candidate", "popul", "eleitor" };
        foreach (var route in new[] { "/api/v1/creator/geo/ufs", Cities("MG", "sao"), Cities("DF") })
        {
            var result = await GateFc.GetAsync(client, route);
            Assert.Equal(200, result.Status);
            var names = GateFc.PropertyNames(result.Body).Select(n => n.ToLowerInvariant()).ToArray();
            Assert.Empty(names.Where(n => forbidden.Any(n.Contains)));
        }
        var df = await GateFc.GetAsync(client, Cities("DF"));
        Assert.Equal(["items", "nextCursor"], df.Body.EnumerateObject().Select(p => p.Name).Order().ToArray());
        Assert.Equal(["ibge", "name", "porte", "uf"], Items(df.Body).Single().EnumerateObject().Select(p => p.Name).Order().ToArray());
    }

    // ───────────────────────── LIMITES-CONFIG ─────────────────────────

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Config_exposes_geo_and_indicator_limits_from_configuration()
    {
        var (id, owner) = await GateFc.SeedBusinessAsync();
        await using var factory = Api();
        using var client = factory.Client($"user:{owner}");
        var result = await GateFc.GetAsync(client, $"/api/v1/creator/config?businessId={id}");
        Assert.Equal(200, result.Status);
        Assert.Equal(1, result.Body.GetProperty("version").GetInt32());
        var limits = result.Body.GetProperty("limits");
        var expected = new Dictionary<string, double>
        {
            ["geoPageSize"] = 15, ["geoDebounceMs"] = 250, ["geoQueryMaxChars"] = 60, ["geoCacheSeconds"] = 86400,
            ["indicatorsPerSingle"] = 3, ["indicatorsPerSlide"] = 2, ["indicatorsPerCarousel"] = 8,
        };
        foreach (var (name, value) in expected) Assert.Equal(value, limits.GetProperty(name).GetDouble());
        await using var tuned = Api((GateFc.KeyOf("IndicatorsPerSingle"), "4"), (GateFc.KeyOf("GeoQueryMaxChars"), "40"));
        using var tunedClient = tuned.Client($"user:{owner}");
        var tunedResult = await GateFc.GetAsync(tunedClient, $"/api/v1/creator/config?businessId={id}");
        Assert.Equal(4, tunedResult.Body.GetProperty("limits").GetProperty("indicatorsPerSingle").GetInt32());
        Assert.Equal(40, tunedResult.Body.GetProperty("limits").GetProperty("geoQueryMaxChars").GetInt32());
    }

    [Fact]
    public void Invalid_geo_or_indicator_ranges_stop_the_startup()
    {
        GateFc.AssertStartupFails(GateFc.Settings((GateFc.KeyOf("GeoQueryMaxChars"), "0")));
        GateFc.AssertStartupFails(GateFc.Settings((GateFc.KeyOf("GeoCacheSeconds"), "0")));
        GateFc.AssertStartupFails(GateFc.Settings((GateFc.KeyOf("IndicatorsPerSingle"), "0")));
        GateFc.AssertStartupFails(GateFc.Settings((GateFc.KeyOf("IndicatorsPerSlide"), "9"), (GateFc.KeyOf("IndicatorsPerCarousel"), "8")));
    }

    // ───────────────────────── RATE-LIMIT ─────────────────────────

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Creator_geo_bucket_allows_the_burst_then_answers_429()
    {
        // Gate corrigido (decisão D): 100000 fora da faixa 1..10000 abortava a subida; o teste prova o balde Geo, não a janela global.
        await using var factory = Api(("RateLimiting:PermitLimit", "10000"), ("RateLimiting:Creator:Geo:TokensPerSecond", "1"),
            ("RateLimiting:Creator:Geo:BurstTokens", "16"), ("RateLimiting:Creator:Geo:QueueLimit", "0"));
        using var client = User(factory);
        var ok = 0;
        string? code = null;
        for (var i = 0; i < 40; i++)
        {
            var result = await GateFc.GetAsync(client, "/api/v1/creator/geo/ufs");
            if (result.Status == 429) { code = GateFc.Code(result.Body); break; }
            Assert.Equal(200, result.Status);
            ok++;
        }
        Assert.Equal("rate_limit_exceeded", code);
        Assert.InRange(ok, 16, 18);
        using var other = User(factory);
        Assert.Equal(200, (await GateFc.GetAsync(other, "/api/v1/creator/geo/ufs")).Status);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Other_routes_stay_under_the_per_user_policy_while_geo_has_its_own_bucket()
    {
        await using var factory = Api(("RateLimiting:PermitLimit", "3"), ("RateLimiting:Creator:Geo:TokensPerSecond", "1000"),
            ("RateLimiting:Creator:Geo:BurstTokens", "1000"), ("RateLimiting:Creator:Geo:QueueLimit", "0"));
        using var client = User(factory);
        var statuses = new List<int>();
        for (var i = 0; i < 6; i++) statuses.Add((await GateFc.GetAsync(client, "/api/v1/creator/config?businessId=nao-importa")).Status);
        Assert.DoesNotContain(429, statuses.Take(3));
        Assert.Contains(429, statuses);
        for (var i = 0; i < 30; i++) Assert.Equal(200, (await GateFc.GetAsync(client, "/api/v1/creator/geo/ufs")).Status);
    }

    // ───────────────────────── SEM-SECAO-ELEITORAL ─────────────────────────

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Section_route_is_not_mapped_even_with_the_electoral_flag()
    {
        foreach (var flag in new[] { "false", "true" })
        {
            await using var factory = Api(Roomy.Append(("Creator:ElectoralContextEnabled", flag)).ToArray());
            using var client = User(factory);
            foreach (var route in new[] { "/api/v1/creator/geo/secoes?uf=MG", "/api/v1/creator/geo/secoes?uf=MG&ibge=3122306", "/api/v1/creator/geo/zonas?uf=MG" })
            {
                var result = await GateFc.GetAsync(client, route);
                Assert.Equal(404, result.Status);
            }
            Assert.Equal(200, (await GateFc.GetAsync(client, "/api/v1/creator/geo/ufs")).Status);
        }
    }
}
