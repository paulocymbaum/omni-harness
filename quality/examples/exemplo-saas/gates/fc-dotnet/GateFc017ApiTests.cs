// Gates FC-017 de API (template): FAIL-CLOSED, API-USUARIO, API-BUSINESS, EMAIL-VERIFICADO (HTTP), NOME-NAO-AUTORIZA (HTTP),
// 404-UNIFORME, COBERTURA-ROTAS, BILLING-INALTERADO (rotas e amostra) e a base da REGRESSAO. Só HTTP e SQL (PostgreSQL de teste).
// Porta de entrada: Homologacao:Creator no modo e nas listas dados; tokens "user:<uid>" (e-mail `uid@example.test`, SEM
// email_verified) e tokens próprios com claims (GateHom.Token). Papéis e vínculo seguem como antes (RN-02): a homologação só abre a porta.
// Negar = 404 `creator_disabled` (nunca 403, para não provar que a conta existe). Valores sintéticos.
using System.Reflection;
using System.Text;
using System.Text.Json;

namespace Fluxo.Api.Tests;

public sealed class GateFc017ApiTests
{
    private static readonly string[] BadBusinessIds = ["a%2Fb"];

    private static async Task AssertAllDisabledAsync(HttpClient client, string businessId, string who)
    {
        GateHom.AssertDisabled404(await GateFc.GetAsync(client, GateHom.Config(businessId)), $"{who} GET /config");
        GateHom.AssertDisabled404(await GateFc.GetAsync(client, GateHom.Kit(businessId)), $"{who} GET /brand-kit");
        GateHom.AssertDisabled404(await GateFc.GetAsync(client, GateHom.Geo(businessId)), $"{who} GET /geo/ufs");
        GateHom.AssertDisabled404(await GateFc.GetAsync(client, GateHom.Ufs), $"{who} GET /geo/ufs sem businessId");
        GateHom.AssertDisabled404(await GateFc.GetAsync(client, $"/api/v1/creator/geo/municipios?uf=MG&q=div"), $"{who} GET /geo/municipios");
        foreach (var (method, path, body) in new (HttpMethod, string, object?)[]
        {
            (HttpMethod.Put, "/palette", new { colors = new[] { "#FFFFFF", "#000000" } }),
            (HttpMethod.Post, "/assets/uploads", new { purpose = "template", fileName = "a.png", contentType = "image/png", sizeBytes = 100 }),
            (HttpMethod.Delete, "/watermark", null),
            (HttpMethod.Delete, $"/templates/{Guid.NewGuid()}", null),
        })
            GateHom.AssertDisabled404(await GateFc2.CallAsync(client, method, GateHom.Kit(businessId, path), body), $"{who} {method} /brand-kit{path}");
    }

    // ───────────────────────── FAIL-CLOSED ─────────────────────────

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Empty_lists_close_the_creator_for_everyone_even_the_owner_of_the_account()
    {
        var (id, owner) = await GateFc.SeedBusinessAsync();
        foreach (var lists in new[] { new Lists(), new Lists(" , ;", "  ", ";;"), new Lists("none", "none", "none") })
        {
            await using var factory = GateHom.Api("Allowlist", lists);
            using var client = factory.Client($"user:{owner}");
            await AssertAllDisabledAsync(client, id, $"dono ({lists})");
        }
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Missing_mode_means_allowlist_and_only_emails_with_an_unverified_user_stays_out()
    {
        using (var host = GateHom.Host(new Dictionary<string, string?> { ["Homologacao:Creator:AllowedUserUids"] = "gate-user-a" }))
        {
            Assert.Equal("ViaUser", GateHom.EvalUser(host, "creator", "gate-user-a"));
            Assert.Equal("Denied", GateHom.EvalUser(host, "creator", "gate-user-z"));
        }
        var uid = GateHom.NewUid();
        await using var factory = GateHom.Api("Allowlist", new Lists(Emails: $"{uid}@example.test"));
        using var unverified = factory.Client($"user:{uid}");
        GateHom.AssertDisabled404(await GateFc.GetAsync(unverified, GateHom.Ufs), "e-mail listado sem email_verified");
        using var falseClaim = factory.Client(GateHom.Token(uid, $"{uid}@example.test", "false"));
        GateHom.AssertDisabled404(await GateFc.GetAsync(falseClaim, GateHom.Ufs), "e-mail listado com email_verified=false");
        using var verified = factory.Client(GateHom.Token(uid, $"{uid}@example.test", "true"));
        Assert.Equal(200, await GateHom.StatusAsync(verified, GateHom.Ufs));
    }

    // ───────────────────────── API-USUARIO ─────────────────────────

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Listed_uids_reach_the_creator_with_their_roles_and_everyone_else_gets_404()
    {
        var (id, owner) = await GateFc.SeedBusinessAsync();
        var viewer = await GateFc.SeedMemberAsync(id, "VIEWER");
        var (otherId, otherOwner) = await GateFc.SeedBusinessAsync();
        var listedStranger = GateHom.NewUid();
        await using var factory = GateHom.Api("Allowlist", new Lists($"{owner},{viewer};{listedStranger}"));

        using var ownerClient = factory.Client($"user:{owner}");
        var config = await GateFc.GetAsync(ownerClient, GateHom.Config(id));
        Assert.Equal(200, config.Status);
        Assert.Equal("owner", config.Body.GetProperty("access").GetProperty("role").GetString());
        Assert.Equal(200, (await GateFc.GetAsync(ownerClient, GateHom.Kit(id))).Status);
        Assert.Equal(200, (await GateFc2.CallAsync(ownerClient, HttpMethod.Put, GateHom.Kit(id, "/palette"), new { colors = new[] { "#FFFFFF", "#000000" } })).Status);
        Assert.Equal(200, await GateHom.StatusAsync(ownerClient, GateHom.Ufs));
        Assert.Equal(200, await GateHom.StatusAsync(ownerClient, "/api/v1/creator/geo/municipios?uf=MG&q=div"));

        using var viewerClient = factory.Client($"user:{viewer}");
        var viewerConfig = await GateFc.GetAsync(viewerClient, GateHom.Config(id));
        Assert.Equal(200, viewerConfig.Status);
        Assert.Equal("viewer", viewerConfig.Body.GetProperty("access").GetProperty("role").GetString());
        Assert.Equal(200, (await GateFc.GetAsync(viewerClient, GateHom.Kit(id))).Status);
        var denied = await GateFc2.CallAsync(viewerClient, HttpMethod.Put, GateHom.Kit(id, "/palette"), new { colors = new[] { "#FFFFFF", "#000000" } });
        Assert.Equal(403, denied.Status);
        Assert.Equal("creator_permission_denied", GateFc.Code(denied.Body));

        // Liberado sem vínculo: a porta abre e o 403 de sempre responde (inalterado).
        using var listedClient = factory.Client($"user:{listedStranger}");
        var noLink = await GateFc.GetAsync(listedClient, GateHom.Config(id));
        Assert.Equal(403, noLink.Status);
        Assert.Equal("business_access_denied", GateFc.Code(noLink.Body));
        Assert.Equal(200, await GateHom.StatusAsync(listedClient, GateHom.Ufs));

        // Não liberado: 404 creator_disabled em tudo, inclusive dono de outra conta e estranho.
        using var stranger = factory.Client($"user:{GateHom.NewUid("gate-stranger")}");
        await AssertAllDisabledAsync(stranger, id, "estranho");
        using var otherOwnerClient = factory.Client($"user:{otherOwner}");
        await AssertAllDisabledAsync(otherOwnerClient, otherId, "dono não listado");
    }

    // ───────────────────────── API-BUSINESS (válvula) ─────────────────────────

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Business_list_valve_releases_active_members_only_and_never_answers_403_to_the_rest()
    {
        var (id, owner) = await GateFc.SeedBusinessAsync();
        var viewer = await GateFc.SeedMemberAsync(id, "VIEWER");
        var operatorUid = await GateFc.SeedMemberAsync(id, "OPERATOR");
        var revoked = await GateFc.SeedMemberAsync(id, "EDITOR");
        await GateHom.RevokeAsync(id, revoked);
        var (otherId, otherOwner) = await GateFc.SeedBusinessAsync();
        await using var factory = GateHom.Api("Allowlist", new Lists(Businesses: id));

        using var ownerClient = factory.Client($"user:{owner}");
        Assert.Equal(200, (await GateFc.GetAsync(ownerClient, GateHom.Config(id))).Status);

        using var viewerClient = factory.Client($"user:{viewer}");
        var config = await GateFc.GetAsync(viewerClient, GateHom.Config(id));
        Assert.Equal(200, config.Status);
        Assert.Equal("viewer", config.Body.GetProperty("access").GetProperty("role").GetString());
        Assert.Equal(200, (await GateFc.GetAsync(viewerClient, GateHom.Kit(id))).Status);
        var write = await GateFc2.CallAsync(viewerClient, HttpMethod.Put, GateHom.Kit(id, "/palette"), new { colors = new[] { "#FFFFFF", "#000000" } });
        Assert.Equal(403, write.Status);
        Assert.Equal("creator_permission_denied", GateFc.Code(write.Body));

        using var operatorClient = factory.Client($"user:{operatorUid}");
        var unknownRole = await GateFc.GetAsync(operatorClient, GateHom.Config(id));
        Assert.Equal(403, unknownRole.Status);
        Assert.Equal("creator_access_denied", GateFc.Code(unknownRole.Body));

        // Não membro e membro revogado: 404, nunca 403.
        using var stranger = factory.Client($"user:{GateHom.NewUid("gate-stranger")}");
        GateHom.AssertDisabled404(await GateFc.GetAsync(stranger, GateHom.Config(id)), "não membro /config");
        GateHom.AssertDisabled404(await GateFc.GetAsync(stranger, GateHom.Kit(id)), "não membro /brand-kit");
        using var revokedClient = factory.Client($"user:{revoked}");
        GateHom.AssertDisabled404(await GateFc.GetAsync(revokedClient, GateHom.Config(id)), "revogado /config");
        GateHom.AssertDisabled404(await GateFc.GetAsync(revokedClient, GateHom.Geo(id)), "revogado /geo");

        // Geo: sem businessId só vale o uid; com a conta liberada o membro entra; conta não liberada continua 404.
        GateHom.AssertDisabled404(await GateFc.GetAsync(viewerClient, GateHom.Ufs), "membro sem businessId");
        GateHom.AssertDisabled404(await GateFc.GetAsync(viewerClient, "/api/v1/creator/geo/municipios?uf=MG&q=div"), "membro sem businessId (municipios)");
        Assert.Equal(200, await GateHom.StatusAsync(viewerClient, GateHom.Geo(id)));
        Assert.Equal(200, await GateHom.StatusAsync(viewerClient, $"/api/v1/creator/geo/municipios?uf=MG&q=div&businessId={id}"));
        using var otherOwnerClient = factory.Client($"user:{otherOwner}");
        GateHom.AssertDisabled404(await GateFc.GetAsync(otherOwnerClient, GateHom.Geo(otherId)), "membro de conta não liberada");

        // businessId repetido, com vírgula ou inválido não libera.
        GateHom.AssertDisabled404(await GateFc.GetAsync(viewerClient, $"{GateHom.Ufs}?businessId={id}&businessId={id}"), "businessId repetido");
        GateHom.AssertDisabled404(await GateFc.GetAsync(viewerClient, $"{GateHom.Ufs}?businessId={id},{otherId}"), "businessId com vírgula");
        foreach (var bad in BadBusinessIds)
            GateHom.AssertDisabled404(await GateFc.GetAsync(viewerClient, $"{GateHom.Ufs}?businessId={bad}"), "businessId inválido");
        GateHom.AssertDisabled404(await GateFc.GetAsync(viewerClient, $"{GateHom.Ufs}?businessId="), "businessId vazio");
    }

    // ───────────────────────── EMAIL-VERIFICADO (HTTP) ─────────────────────────

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Listed_verified_email_releases_and_every_other_form_stays_out()
    {
        var listed = GateHom.NewEmail();
        var listedUid = GateHom.NewUid();
        await using var factory = GateHom.Api("Allowlist", new Lists(Emails: listed));

        async Task<int> Status(string token, string route = GateHom.Ufs)
        {
            using var client = factory.Client(token);
            return await GateHom.StatusAsync(client, route);
        }

        Assert.Equal(200, await Status(GateHom.Token(GateHom.NewUid(), listed, "true")));
        Assert.Equal(200, await Status(GateHom.Token(GateHom.NewUid(), listed.Replace("@example.test", "@Example.TEST"), "true")));
        Assert.Equal(404, await Status(GateHom.Token(GateHom.NewUid(), listed, "false")));
        Assert.Equal(404, await Status(GateHom.Token(GateHom.NewUid(), listed, null)));
        Assert.Equal(404, await Status(GateHom.Token(GateHom.NewUid(), null, "true")));
        Assert.Equal(404, await Status(GateHom.Token(GateHom.NewUid(), GateHom.NewEmail(), "true")));
        // O e-mail de outra pessoa na query ou no cabeçalho não conta: só o do token verificado.
        Assert.Equal(404, await Status(GateHom.Token(GateHom.NewUid(), GateHom.NewEmail(), "true"), $"{GateHom.Ufs}?email={Uri.EscapeDataString(listed)}&uid={listedUid}"));

        await using var withUid = GateHom.Api("Allowlist", new Lists(listedUid, listed));
        using var phoneLogin = withUid.Client(GateHom.Token(listedUid));
        Assert.Equal(200, await GateHom.StatusAsync(phoneLogin, GateHom.Ufs));
    }

    // ───────────────────────── NOME-NAO-AUTORIZA (HTTP) ─────────────────────────

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task A_name_or_display_name_equal_to_a_listed_value_never_authorizes()
    {
        var (id, _) = await GateFc.SeedBusinessAsync();
        var member = await GateFc.SeedMemberAsync(id, "VIEWER");
        var listedUid = GateHom.NewUid();
        var listedEmail = GateHom.NewEmail();
        await using var factory = GateHom.Api("Allowlist", new Lists(listedUid, listedEmail));
        foreach (var (name, display) in new[] { (listedUid, listedEmail), (listedEmail, listedUid), (listedUid, listedUid), ("Fulano Gate", listedEmail) })
        {
            using var client = factory.Client(GateHom.Token(member, GateHom.NewEmail("gate-intruder"), "true", name, display));
            GateHom.AssertDisabled404(await GateFc.GetAsync(client, GateHom.Ufs), $"nome={name}");
            GateHom.AssertDisabled404(await GateFc.GetAsync(client, GateHom.Config(id)), $"nome={name} /config do membro");
            GateHom.AssertDisabled404(await GateFc.GetAsync(client, GateHom.Geo(id)), $"nome={name} /geo");
        }
        using var control = factory.Client(GateHom.Token(listedUid, null, null, name: "Qualquer Nome"));
        Assert.Equal(200, await GateHom.StatusAsync(control, GateHom.Ufs));
    }

    // ───────────────────────── 404-UNIFORME ─────────────────────────

    private sealed record Shot(int Status, SortedDictionary<string, string> Body, SortedDictionary<string, string> Headers)
    {
        public override string ToString() =>
            $"{Status} body[{string.Join(", ", Body.Select(p => $"{p.Key}={p.Value}"))}] headers[{string.Join(", ", Headers.Select(p => $"{p.Key}={p.Value}"))}]";
    }

    private static async Task<Shot> ShootAsync(HttpClient client, HttpMethod method, string route, string? json)
    {
        using var request = new HttpRequestMessage(method, route);
        if (method != HttpMethod.Get) request.Headers.Add("Idempotency-Key", Guid.NewGuid().ToString("N"));
        if (json is not null) request.Content = new StringContent(json, Encoding.UTF8, "application/json");
        using var response = await client.SendAsync(request);
        var text = await response.Content.ReadAsStringAsync();
        var body = new SortedDictionary<string, string>(StringComparer.Ordinal);
        try
        {
            using var doc = JsonDocument.Parse(text);
            foreach (var property in doc.RootElement.EnumerateObject().Where(p => p.Name is not ("traceId" or "instance")))
                // `correlationId` é um GUID novo por requisição (CorrelationIdMiddleware): o valor nunca bate entre duas respostas.
                // A CHAVE continua exigida: guarda só que o valor é não vazio e entra na comparação como marcador fixo.
                body[property.Name] = property.Name == "correlationId"
                    ? (property.Value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(property.Value.GetString()) ? "<present>" : "<empty>")
                    : property.Value.GetRawText();
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException) { body["_raw"] = text; }
        var headers = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (name, values) in response.Headers.Concat(response.Content.Headers))
        {
            var lower = name.ToLowerInvariant();
            if (lower is "date" or "content-length" or "traceparent" || lower.Contains("trace") || lower.Contains("correlation") || lower.Contains("request-id")) continue;
            headers[name] = string.Join(",", values);
        }
        return new Shot((int)response.StatusCode, body, headers);
    }

    private static void AssertSame(Shot reference, Shot actual, string what)
    {
        Assert.True(reference.Status == actual.Status, $"{what}: status {actual.Status} != {reference.Status}\n{actual}\n{reference}");
        Assert.True(reference.Body.SequenceEqual(actual.Body), $"{what}: corpo difere do recurso desligado\nnegado:    {actual}\ndesligado: {reference}");
        Assert.True(reference.Headers.SequenceEqual(actual.Headers), $"{what}: cabeçalhos diferem do recurso desligado\nnegado:    {actual}\ndesligado: {reference}");
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Denied_looks_exactly_like_a_disabled_creator_even_with_a_malformed_body()
    {
        var (id, _) = await GateFc.SeedBusinessAsync();
        var uid = GateHom.NewUid();
        // Referência: Creator:Enabled=false (modo Open). O recurso desligado só responde 404 depois de ligar o corpo (o filtro roda
        // depois do binding), então o JSON malformado é comparado com a resposta desligada da MESMA rota com corpo válido.
        var cases = new (HttpMethod Method, string Route, string? Valid, string? Malformed)[]
        {
            (HttpMethod.Get, GateHom.Config(id), null, null),
            (HttpMethod.Get, GateHom.Kit(id), null, null),
            (HttpMethod.Put, GateHom.Kit(id, "/palette"), "{\"colors\":[\"#FFFFFF\",\"#000000\"]}", "{\"colors\":"),
            (HttpMethod.Post, GateHom.Kit(id, "/templates"), $"{{\"assetId\":\"{Guid.NewGuid()}\",\"viewportPreset\":\"feed_square\"}}", "{\"assetId\":"),
            (HttpMethod.Patch, GateHom.Kit(id, $"/templates/{Guid.NewGuid()}"), "{\"name\":\"gate\"}", "{\"name\":"),
            (HttpMethod.Delete, GateHom.Kit(id, $"/templates/{Guid.NewGuid()}"), null, null),
            (HttpMethod.Get, GateHom.Ufs, null, null),
            (HttpMethod.Get, "/api/v1/creator/geo/municipios?uf=MG&q=div", null, null),
        };
        var references = new List<Shot>();
        await using (var disabled = GateHom.Api("Open", null, null, false, ("Creator:Enabled", "false")))
        {
            using var client = disabled.Client($"user:{uid}");
            foreach (var c in cases)
            {
                var shot = await ShootAsync(client, c.Method, c.Route, c.Valid);
                Assert.True(shot.Status == 404 && shot.Body.GetValueOrDefault("code") == "\"creator_disabled\"", $"referência {c.Method} {c.Route}: {shot}");
                references.Add(shot);
            }
        }
        await using var closed = GateHom.Api("Allowlist");
        using var user = closed.Client($"user:{uid}");
        for (var i = 0; i < cases.Length; i++)
        {
            var c = cases[i];
            AssertSame(references[i], await ShootAsync(user, c.Method, c.Route, c.Valid), $"{c.Method} {c.Route}");
            if (c.Malformed is not null) AssertSame(references[i], await ShootAsync(user, c.Method, c.Route, c.Malformed), $"{c.Method} {c.Route} com JSON malformado");
        }
        using var anonymous = closed.CreateClient();
        foreach (var route in new[] { GateHom.Config(id), GateHom.Ufs })
        {
            var result = await GateFc.GetAsync(anonymous, route);
            Assert.Equal(401, result.Status);
            Assert.Equal("firebase_id_token_required", GateFc.Code(result.Body));
        }
    }

    // ───────────────────────── COBERTURA-ROTAS e BILLING-INALTERADO (rotas) ─────────────────────────

    // Exceções uid-only comentadas: rota do Creator sem `businessId` no handler (a regra 1 é a única que a libera).
    // /config e /geo/* já são tratadas à parte: /config exige businessId; /geo/* aceita businessId opcional na query lido só pelo middleware.
    private static readonly string[] UidOnlyExceptions = [];

    [Fact]
    public async Task Every_creator_route_carries_the_requirement_and_exposes_a_business_id()
    {
        await using var factory = new DebateApiFactory(null, settings: GateFc.Settings());
        var routes = GateHom.Endpoints(factory).Where(e => e.RoutePattern.RawText!.StartsWith("/api/v1/creator", StringComparison.OrdinalIgnoreCase)).ToArray();
        Assert.True(routes.Length >= 14, $"esperava ao menos 14 rotas sob /api/v1/creator, encontrei {routes.Length}");
        foreach (var route in routes)
        {
            var pattern = route.RoutePattern.RawText!;
            var requirement = GateHom.RequirementOf(route);
            Assert.True(requirement is not null, $"{pattern}: sem HomologacaoRequirement (o grupo /creator declara o metadado uma vez)");
            Assert.Equal("creator", GateHom.FeatureOf(requirement!)?.ToLowerInvariant());
            if (pattern.Contains("/creator/geo/", StringComparison.OrdinalIgnoreCase) || UidOnlyExceptions.Contains(pattern)) continue;
            var handlerHasBusinessId = route.Metadata.OfType<MethodInfo>().Any(m => m.GetParameters().Any(p => p.Name == "businessId"));
            Assert.True(handlerHasBusinessId || route.RoutePattern.GetParameter("businessId") is not null,
                $"{pattern}: rota do Creator sem parâmetro businessId (rota ou query); só /geo/* e a lista de exceções uid-only ficam de fora");
        }
    }

    [Fact]
    public async Task Only_creator_routes_carry_the_requirement_and_billing_routes_exist_without_it()
    {
        await using var factory = new DebateApiFactory(null, settings: GateFc.Settings());
        var all = GateHom.Endpoints(factory).ToArray();
        Assert.True(all.Any(e => e.RoutePattern.RawText!.StartsWith("/api/v1/creator", StringComparison.OrdinalIgnoreCase) && GateHom.RequirementOf(e) is not null),
            "HomologacaoRequirement não chegou a nenhuma rota do Creator");
        var billing = all.Where(e => e.RoutePattern.RawText!.Contains("/billing", StringComparison.OrdinalIgnoreCase)).ToArray();
        Assert.True(billing.Length >= 10, $"esperava ao menos 10 rotas de Billing (inclusive admin e webhooks), encontrei {billing.Length}");
        Assert.True(billing.Any(e => e.RoutePattern.RawText!.StartsWith("/api/v1/admin/billing", StringComparison.OrdinalIgnoreCase)), "rotas admin de Billing ausentes");
        Assert.True(billing.Any(e => e.RoutePattern.RawText!.StartsWith("/webhooks", StringComparison.OrdinalIgnoreCase)), "webhooks de Billing ausentes");
        var offenders = all.Where(e => !e.RoutePattern.RawText!.StartsWith("/api/v1/creator", StringComparison.OrdinalIgnoreCase) && GateHom.RequirementOf(e) is not null)
            .Select(e => e.RoutePattern.RawText).ToArray();
        Assert.Equal(Array.Empty<string?>(), offenders);
    }

    // ───────────────────────── BILLING-INALTERADO (amostra de respostas) ─────────────────────────

    private static async Task<string[]> SampleAsync(string mode, string businessId, string ownerUid, string adminWith, string adminWithout)
    {
        await using var factory = GateHom.Api(mode, null, null, false,
            ("Billing:Enabled", "true"), ("Billing:Provider", "stub"), ("Homologacao:Billing:Mode", mode),
            ("Homologacao:Billing:AllowedUserUids", ""), ("Homologacao:Billing:AllowedUserEmails", ""), ("Homologacao:Billing:AllowedBusinessIds", ""));
        factory.Registry.Grant(adminWith, "admin", "billing.read");
        using var anonymous = factory.CreateClient();
        using var owner = factory.Client($"user:{ownerUid}");
        using var allowed = factory.Client(DebateApiFactory.Admin(adminWith));
        using var forbidden = factory.Client(DebateApiFactory.Admin(adminWithout));
        var lines = new List<string>();
        async Task Add(string name, HttpClient client, HttpMethod method, string route, object? body = null)
        {
            var result = await GateFc2.CallAsync(client, method, route, body);
            lines.Add($"{name}: {result.Status} {GateFc.Code(result.Body)}");
        }
        await Add("catalog anônimo", anonymous, HttpMethod.Get, "/api/v1/billing/catalog");
        await Add("entitlements do dono", owner, HttpMethod.Get, $"/api/v1/billing/subjects/business/{businessId}/entitlements");
        await Add("admin com permissão", allowed, HttpMethod.Get, $"/api/v1/admin/billing/subjects/business/{businessId}");
        await Add("admin sem permissão", forbidden, HttpMethod.Get, $"/api/v1/admin/billing/subjects/business/{businessId}");
        await Add("equipe do dono", owner, HttpMethod.Get, $"/api/v1/businesses/{businessId}/team");
        await Add("merchant inexistente", owner, HttpMethod.Get, $"/api/v1/fluxo-empresas/merchants/gate-merchant-{Guid.NewGuid():N}");
        await Add("merchant sem corpo válido", owner, HttpMethod.Post, "/api/v1/fluxo-empresas/merchants", new { });
        return lines.ToArray();
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Billing_and_team_routes_answer_the_same_with_homologacao_closed_or_open()
    {
        // Sem Homologacao o teste passaria por natureza (Billing não muda): exigir o mecanismo é o que o faz falhar na linha de base.
        GateFc.Find("HomologacaoRequirement");
        GateFc.Find("HomologacaoEvaluator");
        await DebateTestDb.EnsureAsync();
        await DebateTestDb.ExecAsync(GateFc.C, DebateTestDb.Sql("billing-mvp.sql"));
        var (id, owner) = await GateFc.SeedBusinessAsync();
        var (adminWith, adminWithout) = ($"admin-{Guid.NewGuid():N}", $"admin-{Guid.NewGuid():N}");
        var open = await SampleAsync("Open", id, owner, adminWith, adminWithout);
        var closed = await SampleAsync("Allowlist", id, owner, adminWith, adminWithout);
        Assert.True(open.SequenceEqual(closed), $"Billing/FluxoEmpresas mudaram com Homologacao fechada:\naberta:\n{string.Join('\n', open)}\nfechada:\n{string.Join('\n', closed)}");
        Assert.StartsWith("catalog anônimo: 200", open[0]);
        Assert.StartsWith("entitlements do dono: 200", open[1]);
        Assert.StartsWith("admin com permissão: 200", open[2]);
        Assert.StartsWith("admin sem permissão: 403", open[3]);
        Assert.StartsWith("equipe do dono: 200", open[4]);
        Assert.DoesNotContain(open, line => line.Contains(": 5"));
    }

    // ───────────────────────── REGRESSAO (base) ─────────────────────────

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Base_gate_settings_keep_the_creator_open_for_the_existing_gates()
    {
        var (id, owner) = await GateFc.SeedBusinessAsync();
        await using var factory = new DebateApiFactory(GateFc.C, settings: GateFc.Settings());
        using var client = factory.Client($"user:{owner}");
        Assert.Equal(200, (await GateFc.GetAsync(client, GateHom.Config(id))).Status);
        using var stranger = factory.Client($"user:{GateHom.NewUid("gate-stranger")}");
        Assert.Equal(200, await GateHom.StatusAsync(stranger, GateHom.Ufs));
        var evaluator = factory.Services.GetService(GateFc.Find("HomologacaoEvaluator"));
        Assert.True(evaluator is not null, "HomologacaoEvaluator não registrado na API");
        using var host = GateHom.Host(GateHom.Lists3("creator", mode: "Open"));
        Assert.Equal("Open", GateHom.EvalUser(host, "creator", GateHom.NewUid()));
    }
}
