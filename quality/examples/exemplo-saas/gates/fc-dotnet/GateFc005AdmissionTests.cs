// Gates FC-005-ADMISSAO (template). CreatorJobAdmission é lido por reflexão (nome simples do tipo, padrão FC-004),
// então compila antes de existir e falha dizendo o que falta. Contrato fixado pelo gate a partir da spec:
//   CreatorJobAdmission registrado na DI por AddCreatorModule (singleton) com
//     AdmitAsync(FluxoDbContext db, string businessId, CreatorJobLane lane, int priority, CancellationToken ct)
//       -> Task<CreatorAdmission> (Allowed: bool, QueuedAhead: int, EtaSeconds: int?, Position: int?)
//   Recusa é ApiException: 429 creator.queue_full / 503 creator.capacity, ambos com Extensions["retryAfterSeconds"] (int, 1..900).
//   Configuração por Creator:Queue:* (CapacityEtaSeconds, CapacityMaxQueuedPerReplica, Replicas, EtaWindowMinutes,
//   EtaDefaultLlmSeconds, EtaDefaultRenderSeconds, LaneConcurrencyLlm, LaneConcurrencyRender).
// Jobs de teste são inseridos por SQL na conta semeada por GateFc.SeedBusinessAsync (FK de creator_jobs vale).
using System.Reflection;
using System.Text.Json;
using Fluxo.Api.Bootstrap;
using Fluxo.Api.Infrastructure.Persistence;
using Microsoft.Extensions.DependencyInjection;

namespace Fluxo.Api.Tests;

public sealed class GateFc005AdmissionTests
{
    private static DebateApiFactory Api(params (string Key, string? Value)[] extra) =>
        new(GateFc.C, settings: GateFc.Settings(extra));

    private static object Admission(DebateApiFactory factory)
    {
        using var scope = factory.Services.CreateScope();
        return scope.ServiceProvider.GetRequiredService(GateFc.Find("CreatorJobAdmission"));
    }

    private static async Task<object?> AdmitAsync(DebateApiFactory factory, string business, string lane, int priority = 1)
    {
        var admission = Admission(factory);
        var method = admission.GetType().GetMethod("AdmitAsync")
            ?? throw new Xunit.Sdk.XunitException("CreatorJobAdmission sem AdmitAsync(db, businessId, lane, priority, ct)");
        var laneArg = GateFc.Pick(GateFc.Find("CreatorJobLane"), lane);
        await using var db = DebateTestDb.Context();
        var task = (Task)method.Invoke(admission, [db, business, laneArg, priority, CancellationToken.None])!;
        try
        {
            await task;
            return task.GetType().GetProperty("Result")!.GetValue(task);
        }
        catch (Fluxo.Api.Bootstrap.ApiException error)
        {
            return error; // recusa da admissão: o teste inspeciona status, código e retryAfterSeconds
        }
    }

    private static void AssertAdmitted(object? result)
    {
        Assert.True(result is not null, "AdmitAsync devolveu null");
        Assert.True((bool)result!.GetType().GetProperty("Allowed")!.GetValue(result)!,
            $"esperava admissão, veio recusa: {JsonSerializer.Serialize(result)}");
    }

    private static ApiException AssertRefused(object? result, string expectedCode)
    {
        var error = result as ApiException
            ?? throw new Xunit.Sdk.XunitException($"esperava ApiException {expectedCode}, veio {result?.GetType().Name ?? "null"}");
        Assert.Equal(expectedCode, error.Code);
        return error;
    }

    private static int RetryAfterOf(ApiException error)
    {
        int? raw = error.Extensions?.TryGetValue("retryAfterSeconds", out var value) == true ? value as int? : null;
        Assert.True(raw is not null, "recusa sem retryAfterSeconds");
        Assert.InRange(raw!.Value, 1, 900);
        return raw.Value;
    }

    private static async Task SeedQueuedAsync(string business, string lane, int priority, int count)
    {
        var kind = lane == "llm" ? "strategy" : "render";
        for (var index = 0; index < count; index++)
            await DebateTestDb.ExecAsync(GateFc.C, $"""
                INSERT INTO fluxo.creator_jobs (id, business_id, project_id, kind, lane, priority, status, max_attempts,
                    deadline_seconds, expires_at, run_after, created_at, idempotency_key, payload)
                VALUES (gen_random_uuid(), '{business}', gen_random_uuid(), '{kind}', '{lane}', {priority}, 'queued', 3, 120,
                    now() + interval '15 minutes', now(), now() - interval '1 second', '{Guid.NewGuid()}', 'null'::jsonb)
                """);
    }

    private static async Task SeedDoneHistoryAsync(string business, string lane, int averageSeconds, int samples = 1)
    {
        for (var index = 0; index < samples; index++)
            await DebateTestDb.ExecAsync(GateFc.C, $"""
                INSERT INTO fluxo.creator_jobs (id, business_id, project_id, kind, lane, priority, status, max_attempts,
                    deadline_seconds, expires_at, run_after, created_at, idempotency_key, payload, first_started_at, finished_at)
                VALUES (gen_random_uuid(), '{business}', gen_random_uuid(),
                    CASE WHEN '{lane}' = 'llm' THEN 'strategy' ELSE 'render' END, '{lane}', 1, 'done', 3, 120,
                    now() - interval '5 minutes', now() - interval '5 minutes', now() - interval '5 minutes',
                    '{Guid.NewGuid()}', 'null'::jsonb, now() - make_interval(secs => {averageSeconds}),
                    now() - make_interval(secs => 1))
                """);
    }

    // ───────────────────────── ADMISSAO ─────────────────────────

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Queue_full_at_the_cap_answers_429_with_retry_after_and_previews_do_not_count()
    {
        var (factory, business) = await SetupAsync();
        await SeedQueuedAsync(business, "llm", 1, 30);
        var error = AssertRefused(await AdmitAsync(factory, business, "llm"), "creator.queue_full");
        Assert.Equal(429, error.StatusCode);
        RetryAfterOf(error); // segundos até a vaga abrir (expiração do mais recente), dentro de 1..900

        // Prévias (priority 0) não contam no teto: 29 de conta + 5 prévias passa.
        var (factory29, business29) = await SetupAsync();
        await SeedQueuedAsync(business29, "llm", 1, 29);
        await SeedQueuedAsync(business29, "llm", 0, 5);
        AssertAdmitted(await AdmitAsync(factory29, business29, "llm"));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Below_the_cap_is_allowed_with_eta_seconds_from_the_lane_default()
    {
        var (factory, business) = await SetupAsync();
        await SeedQueuedAsync(business, "llm", 1, 5);
        var result = await AdmitAsync(factory, business, "llm");
        AssertAdmitted(result);
        var eta = (int?)result!.GetType().GetProperty("EtaSeconds")!.GetValue(result);
        Assert.True(eta is > 0, $"ETA sem histórico precisa usar o padrão da pista, veio {eta}");
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Capacity_by_eta_answers_503_with_half_eta_retry_after()
    {
        // Cap mínimo (30 s) e média padrão da pista (30 s): 2 jobs à frente com 1 de concorrência => 60 s > 30 s.
        var (factory, business) = await SetupAsync(("Creator:Queue:CapacityEtaSeconds", "30"), ("Creator:Queue:LaneConcurrencyLlm", "1"));
        await SeedQueuedAsync(business, "llm", 1, 2);
        var error = AssertRefused(await AdmitAsync(factory, business, "llm"), "creator.capacity");
        Assert.Equal(503, error.StatusCode);
        Assert.True(RetryAfterOf(error) >= 10, "Retry-After da capacidade precisa ser a metade da ETA (ceil(60/2) = 30, com folga)");
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Absolute_queue_cap_scales_with_replicas_and_answers_503()
    {
        var (factory, business) = await SetupAsync(("Creator:Queue:CapacityMaxQueuedPerReplica", "5"), ("Creator:Queue:Replicas", "2"));
        await SeedQueuedAsync(business, "llm", 1, 10);
        AssertAdmitted(await AdmitAsync(factory, business, "llm")); // 10 <= 2 réplicas × 5
        await SeedQueuedAsync(business, "llm", 1, 1);
        var error = AssertRefused(await AdmitAsync(factory, business, "llm"), "creator.capacity"); // 11 > 10
        Assert.Equal(503, error.StatusCode);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Lane_history_drives_the_eta_instead_of_the_default()
    {
        // Média real de 60 s por job: com cap mínimo (30 s) e 1 job à frente, recusa e o Retry-After é a metade da ETA (30 s).
        var (factory, business) = await SetupAsync(
            ("Creator:Queue:CapacityEtaSeconds", "30"), ("Creator:Queue:LaneConcurrencyLlm", "1"), ("Creator:Queue:EtaWindowMinutes", "10"));
        await SeedDoneHistoryAsync(business, "llm", averageSeconds: 60);
        await SeedQueuedAsync(business, "llm", 1, 1);
        var error = AssertRefused(await AdmitAsync(factory, business, "llm"), "creator.capacity");
        Assert.True(RetryAfterOf(error) >= 25, $"Retry-After devia ser a metade da ETA de 60 s (30), veio {RetryAfterOf(error)}");
    }

    private static async Task<(DebateApiFactory Factory, string Business)> SetupAsync(params (string, string?)[] extra)
    {
        var (id, _) = await GateFc.SeedBusinessAsync();
        // A admissão conta a fila GLOBAL da pista: cada teste começa com ela vazia para não se contaminarem.
        await DebateTestDb.ExecAsync(GateFc.C, "DELETE FROM fluxo.creator_jobs");
        return (Api(extra), id);
    }
}

