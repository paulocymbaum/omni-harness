// Gates FC-012-API (template): rotas do projeto do post único. Só HTTP + SQL direto; compila antes da implementação
// e falha em execução dizendo o que falta. Contrato fixado pela spec:
//   POST   /api/v1/creator/projects?businessId=  (Idempotency-Key, CreatorPermission.Create, rate creator-enqueue)
//          body { recorte:{scope,uf,ibge,name}, contextId, indicatorIds[], prompt, viewport:{preset,width,height} }
//          -> cria fluxo.creator_projects(status 'copying') e enfileira job kind 'slide_copy' com payload contendo
//             factSheetInput{selections,maxIndicators} — CreatorJobAdmission.AdmintAsync ANTES do EnqueueAsync, na
//             MESMA transação (429 creator.queue_full NÃO pode deixar projeto órfão).
//   GET    /projects/{id} -> projeto + jobs
//   GET    /projects/{id}/copy -> lê result_ref (file://…​.json) do store; 409 creator_copy_pending antes do job
//   PUT    /projects/{id}/copy -> copy editada (copy_edited=true)
//   POST   /projects/{id}/render -> monta spec (palette ≥2, origin.label, fundo sólido) e enfileira kind 'render'
//   GET    /projects/{id}/jobs/{jobId}/result -> bytes do PNG; 409 creator_render_pending antes
// Config nos testes: Creator:RenderOutputDir aponta para diretório temporário compartilhado com o "worker".
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;

namespace Fluxo.Api.Tests;

public sealed class GateFc012ProjectsTests
{
    private static readonly (string, string?)[] Roomy =
    [
        ("RateLimiting:PermitLimit", "10000"), ("RateLimiting:Creator:Enqueue:TokensPerSecond", "1000"),
        ("RateLimiting:Creator:Enqueue:BurstTokens", "1000"), ("RateLimiting:Creator:Enqueue:QueueLimit", "0"),
        ("RateLimiting:Creator:Status:TokensPerSecond", "1000"), ("RateLimiting:Creator:Status:BurstTokens", "1000"),
        ("RateLimiting:Creator:Status:QueueLimit", "0"),
    ];

    // Um único dir por execução da classe: a factory registra Creator:RenderOutputDir e o teste grava/lê no MESMO
    // caminho (Guid.NewGuid() por acesso fazia servidor e teste enxergarem diretórios diferentes → DirectoryNotFound).
    private static string? outputDir;
    private static string OutputDir => outputDir ??= Path.Combine(Path.GetTempPath(), $"fc012-{Guid.NewGuid():N}");

    private static DebateApiFactory Api(params (string Key, string? Value)[] extra)
    {
        var list = new List<(string, string?)>(Roomy) { ("Creator:RenderOutputDir", OutputDir) };
        list.AddRange(extra);
        return new(GateFc.C, settings: GateFc.Settings([.. list]));
    }

    private static string Port(string business) => $"/api/v1/creator/projects?businessId={Uri.EscapeDataString(business)}";
    // O id é PATH (contrato da spec: /projects/{id}/...); o businessId segue por query — e o sufixo do sub-recurso
    // (/copy, /render, /jobs/{jobId}/result) tem de vir ANTES do "?", senão vira query string.
    private static string PortId(string business, Guid id, string? suffix = null) =>
        $"/api/v1/creator/projects/{id}{suffix}?businessId={Uri.EscapeDataString(business)}";

    private static StringContent Json(object body) => new(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");

    private static readonly object ValidBody = new
    {
        recorte = new { scope = "municipio", uf = "MG", ibge = "3106200", name = "Belo Horizonte" },
        contextId = "renda",
        indicatorIds = new[] { "renda.media" },
        prompt = "Post sobre a renda média do município",
        viewport = new { preset = "feed", width = 1080, height = 1080 },
    };

    private static async Task<(int Status, JsonElement Body)> SendAsync(HttpClient client, HttpMethod method, string route, object? body = null,
        string? idempotency = null)
    {
        using var request = new HttpRequestMessage(method, route);
        if (idempotency is not null) request.Headers.TryAddWithoutValidation("Idempotency-Key", idempotency);
        if (body is not null) request.Content = Json(body);
        var response = await client.SendAsync(request);
        var text = await response.Content.ReadAsStringAsync();
        return ((int)response.StatusCode, JsonDocument.Parse(string.IsNullOrWhiteSpace(text) ? "{}" : text).RootElement);
    }

    private static async Task<(DebateApiFactory Factory, HttpClient Client, string Business, string Owner)> SetupAsync(params (string Key, string? Value)[] extra)
    {
        var (business, owner) = await GateFc.SeedBusinessAsync();
        var factory = Api(extra);
        return (factory, factory.Client($"user:{owner}"), business, owner);
    }

    private static async Task<(JsonElement Project, string Id)> CreateAsync(HttpClient client, string business, string? idempotency = null)
    {
        var (status, body) = await SendAsync(client, HttpMethod.Post, Port(business), ValidBody, idempotency ?? $"gate-{Guid.NewGuid():N}");
        Assert.True(status is 200 or 201, $"POST /projects devolveu {status}: {body}");
        return (body, body.GetProperty("id").GetString()!);
    }

    private static async Task<JsonElement> JobOf(string business, Guid projectId)
    {
        await using var db = DebateTestDb.Context();
        var row = await db.Database.SqlQuery<string>($"""
            SELECT payload::text AS "Value" FROM fluxo.creator_jobs
            WHERE project_id = {projectId} AND business_id = {business} AND kind = 'slide_copy' LIMIT 1
            """).SingleOrDefaultAsync();
        Assert.False(row is null, "job slide_copy do projeto não encontrado");
        return JsonDocument.Parse(row!).RootElement;
    }


    // ───────────────────────── POST cria e enfileira ─────────────────────────

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Post_creates_copying_project_and_enqueues_slide_copy_with_facts_payload()
    {
        var (factory, client, business, _) = await SetupAsync();
        try
        {
            var (status, body) = await SendAsync(client, HttpMethod.Post, Port(business), ValidBody, "gate-create-1");
            Assert.Equal(201, status);
            Assert.Equal("copying", body.GetProperty("status").GetString());
            var id = Guid.Parse(body.GetProperty("id").GetString()!);

            await using var db = DebateTestDb.Context();
            var project = await db.Database.SqlQuery<string>($"""
                SELECT status::text || '|' || context_id::text AS "Value" FROM fluxo.creator_projects WHERE id = {id}
                """).SingleOrDefaultAsync();
            Assert.Equal("copying|renda", project);

            var payload = await JobOf(business, id);
            Assert.Equal("renda.media", payload.GetProperty("factSheetInput").GetProperty("selections")[0].GetProperty("indicatorId").GetString());
            Assert.Equal(3, payload.GetProperty("factSheetInput").GetProperty("maxIndicators").GetInt32());
            Assert.Equal("Post sobre a renda média do município", payload.GetProperty("prompt").GetString());
            Assert.Equal(1080, payload.GetProperty("viewport").GetProperty("width").GetInt32());
        }
        finally { factory.Dispose(); }
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Idempotency_key_replays_the_same_project()
    {
        var (factory, client, business, _) = await SetupAsync();
        try
        {
            var first = await SendAsync(client, HttpMethod.Post, Port(business), ValidBody, "gate-replay");
            var second = await SendAsync(client, HttpMethod.Post, Port(business), ValidBody, "gate-replay");
            Assert.Equal(first.Body.GetProperty("id").GetString(), second.Body.GetProperty("id").GetString());
            await using var db = DebateTestDb.Context();
            // O domínio (FC-004) compõe a chave: creator_jobs.idempotency_key = "{businessId}:{key}".
            var count = await db.Database.SqlQuery<int>($"SELECT count(*)::int AS \"Value\" FROM fluxo.creator_jobs WHERE idempotency_key = {business} || ':gate-replay'").SingleAsync();
            Assert.Equal(1, count);
        }
        finally { factory.Dispose(); }
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Non_member_is_forbidden()
    {
        var (factory, client, business, _) = await SetupAsync();
        try
        {
            var outsider = factory.Client($"user:{Guid.NewGuid():N}");
            var (status, _) = await SendAsync(outsider, HttpMethod.Post, Port(business), ValidBody, "gate-forbidden");
            Assert.Equal(403, status);
        }
        finally { factory.Dispose(); }
    }

    // ───────────────────────── copy: pendente, gravada, editada ─────────────────────────

    private static async Task<(DebateApiFactory Factory, HttpClient Client, string Business, Guid Project, Guid Job, string Dir)> WithCopyPendingAsync(params (string Key, string? Value)[] extra)
    {
        var (factory, client, business, _) = await SetupAsync(extra);
        var (_, body) = await SendAsync(client, HttpMethod.Post, Port(business), ValidBody, $"gate-copy-{Guid.NewGuid():N}");
        var project = Guid.Parse(body.GetProperty("id").GetString()!);
        await using var db = DebateTestDb.Context();
        var job = Guid.Parse((await db.Database.SqlQuery<string>($"SELECT id::text AS \"Value\" FROM fluxo.creator_jobs WHERE project_id = {project} LIMIT 1").SingleAsync(CancellationToken.None))!);
        // Copy aprovada no projeto (como se o job do LLM tivesse terminado): o POST /render compõe a partir daqui.
        // JSON vai como PARÂMETRO (raw string $$ com chaves de JSON viraria literal no SQL — 42601).
        var copyJson = "{\"balloons\":[{\"role\":\"data\",\"text\":\"R$ 1.234\",\"factRefs\":[\"renda.media\"]}]}";
        await db.Database.ExecuteSqlAsync($"""
            UPDATE fluxo.creator_projects SET copy = {copyJson}::jsonb, status = 'copy_ready'
            WHERE id = {project}
            """);
        return (factory, client, business, project, job, OutputDir);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Copy_is_pending_until_the_job_finishes_then_reads_the_store()
    {
        var (factory, client, business, project, job, dir) = await WithCopyPendingAsync();
        try
        {
            var (pendingStatus, pendingBody) = await SendAsync(client, HttpMethod.Get, PortId(business, project, "/copy"));
            Assert.Equal(409, pendingStatus);
            Assert.Equal("creator_copy_pending", GateFc.Code(pendingBody));

            Directory.CreateDirectory(dir);
            var copy = JsonSerializer.Serialize(new
            {
                balloons = new[] { new { role = "data", text = "R$ 1.234", factRefs = new[] { "renda.media" } } },
                factSheet = new { area = new { uf = "MG" }, allowedNumbers = new[] { 1234 } },
            });
            await File.WriteAllTextAsync(Path.Combine(dir, $"{job}.json"), copy);
            await using (var db = DebateTestDb.Context())
            {
                var copyRef = "file://" + job + ".json";
                await db.Database.ExecuteSqlAsync($"""
                    UPDATE fluxo.creator_jobs SET status = 'done', result_ref = {copyRef}, finished_at = now()
                    WHERE id = {job}
                    """);
            }
            var (status, body) = await SendAsync(client, HttpMethod.Get, PortId(business, project, "/copy"));
            Assert.Equal(200, status);
            Assert.Equal("R$ 1.234", body.GetProperty("balloons")[0].GetProperty("text").GetString());
        }
        finally { factory.Dispose(); }
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Put_copy_marks_edited_and_get_project_lists_jobs()
    {
        var (factory, client, business, project, _, _) = await WithCopyPendingAsync();
        try
        {
            var edited = new { balloons = new[] { new { role = "title", text = "Editado por você" } } };
            var (putStatus, _) = await SendAsync(client, HttpMethod.Put, PortId(business, project, "/copy"), edited);
            Assert.Equal(200, putStatus);
            await using var db = DebateTestDb.Context();
            var row = await db.Database.SqlQuery<string>($"SELECT copy_edited::text || '|' || (copy->'balloons'->0->>'text') AS \"Value\" FROM fluxo.creator_projects WHERE id = {project}").SingleAsync(CancellationToken.None);
            Assert.Equal("true|Editado por você", row);

            var (getStatus, getBody) = await SendAsync(client, HttpMethod.Get, PortId(business, project));
            Assert.Equal(200, getStatus);
            Assert.True(getBody.GetProperty("jobs").GetArrayLength() >= 1, "GET do projeto sem a lista de jobs");
        }
        finally { factory.Dispose(); }
    }


    // ───────────────────────── render: spec montada e resultado ─────────────────────────

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Post_render_enqueues_render_job_with_composed_spec()
    {
        var (factory, client, business, project, _, _) = await WithCopyPendingAsync(("Creator:OriginLabel", "Feito no Fluxo"));
        try
        {
            var (status, body) = await SendAsync(client, HttpMethod.Post, PortId(business, project, "/render"), null, $"gate-render-{Guid.NewGuid():N}");
            Assert.Equal(201, status);
            Assert.NotNull(body.GetProperty("jobId").GetString());
            await using var db = DebateTestDb.Context();
            var payload = await db.Database.SqlQuery<string>($"""
                SELECT payload::text AS "Value" FROM fluxo.creator_jobs WHERE project_id = {project} AND kind = 'render' LIMIT 1
                """).SingleOrDefaultAsync();
            Assert.False(payload is null, "job render não enfileirado");
            var spec = JsonDocument.Parse(payload!).RootElement.GetProperty("spec");
            Assert.Equal("solid", spec.GetProperty("background").GetProperty("kind").GetString());
            Assert.True(spec.GetProperty("palette").GetArrayLength() >= 2, "spec sem paleta de contraste");
            Assert.Equal("Feito no Fluxo", spec.GetProperty("origin").GetProperty("label").GetString());
            Assert.True(spec.GetProperty("balloons").GetArrayLength() >= 1, "spec sem balões da copy");
        }
        finally { factory.Dispose(); }
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Result_is_pending_then_served_from_the_store()
    {
        var (factory, client, business, project, job, dir) = await WithCopyPendingAsync();
        try
        {
            var renderId = Guid.NewGuid();
            var payloadJson = JsonSerializer.Serialize(new { spec = (object?)null });
            await using (var db = DebateTestDb.Context())
            {
                var copyRef = "file://" + job + ".json";
                await db.Database.ExecuteSqlAsync($"""
                    UPDATE fluxo.creator_jobs SET status = 'done', result_ref = {copyRef}, finished_at = now() WHERE id = {job}
                    """);
                await db.Database.ExecuteSqlAsync($"""
                    INSERT INTO fluxo.creator_jobs (id, business_id, project_id, kind, lane, priority, status, deadline_seconds, expires_at, idempotency_key, payload)
                    VALUES ({renderId}, {business}, {project}, 'render', 'render', 1, 'queued', 30, now() + interval '10 minutes', {business} || ':gate-result-1', {payloadJson}::jsonb)
                    """);
            }
            var (pendingStatus, pendingBody) = await SendAsync(client, HttpMethod.Get, PortId(business, project, $"/jobs/{renderId}/result"));
            Assert.Equal(409, pendingStatus);
            Assert.Equal("creator_render_pending", GateFc.Code(pendingBody));

            Directory.CreateDirectory(dir);
            var pngHeader = new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4 };
            await File.WriteAllBytesAsync(Path.Combine(dir, $"{renderId}.png"), pngHeader);
            await using (var db = DebateTestDb.Context())
            {
                var pngRef = "file://" + renderId + ".png";
                await db.Database.ExecuteSqlAsync($"""
                    UPDATE fluxo.creator_jobs SET status = 'done', result_ref = {pngRef}, finished_at = now() WHERE id = {renderId}
                    """);
            }
            var response = await client.GetAsync(PortId(business, project, $"/jobs/{renderId}/result"));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal("image/png", response.Content.Headers.ContentType?.MediaType);
            var bytes = await response.Content.ReadAsByteArrayAsync();
            Assert.Equal(0x89, bytes[0]);
        }
        finally { factory.Dispose(); }
    }

    // ───────────────────────── espelho legado (conta que só existe no Firestore) ─────────────────────────

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Legacy_account_without_business_row_creates_mirror_with_real_owner_profile()
    {
        // Conta legada sem linha na businesses: o espelho precisa satisfazer a FK fk_businesses_profiles_owner
        // com um perfil REAL. Regressão do 500 em produção: o espelho nascia com Guid.NewGuid() de dono e a
        // FK derrubava todo POST /creator/projects da conta (SqlState 23503 → internal_error).
        var (factory, _, business, _) = await SetupAsync();
        try
        {
            // O vínculo do chamador fica na equipe (sem FK para businesses): dá para apagar o espelho e ainda
            // passar pelo RequireMemberAsync sem o diretório legado (Firestore indisponível nos gates).
            var admin = await GateFc.SeedMemberAsync(business, "ADMIN");
            await DebateTestDb.ExecAsync(GateFc.C, $"DELETE FROM fluxo.businesses WHERE id = '{business}'");
            var adminClient = factory.Client($"user:{admin}");

            var (status, body) = await SendAsync(adminClient, HttpMethod.Post, Port(business), ValidBody, $"gate-mirror-{Guid.NewGuid():N}");
            Assert.True(status is 200 or 201, $"POST /projects devolveu {status}: {body}");

            await using var db = DebateTestDb.Context();
            var mirror = await db.Database.SqlQuery<string>($"""
                SELECT b.slug || '|' || p.firebase_uid AS "Value"
                FROM fluxo.businesses b JOIN fluxo.profiles p ON p.id = b.owner_profile_id
                WHERE b.id = {business}
                """).SingleOrDefaultAsync();
            Assert.False(mirror is null, "espelho da conta legada não criado");
            var parts = mirror!.Split('|');
            Assert.StartsWith("empresa-", parts[0]);
            // Dono resolvido: sem banco e sem diretório legado, o chamador (membro que provou o vínculo) assume.
            Assert.Equal(admin, parts[1]);
        }
        finally { factory.Dispose(); }
    }
}

