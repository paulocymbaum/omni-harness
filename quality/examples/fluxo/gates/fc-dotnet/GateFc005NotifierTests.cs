// Gates FC-005-NOTIFICACAO (template). CreatorJobExpiryNotifier é lido por reflexão (padrão FC-004), então compila antes
// de existir. Contrato fixado pelo gate a partir da spec:
//   CreatorJobExpiryNotifier registrado por AddCreatorModule (AddHostedService) e resolvível da DI, com
//     RunOnceAsync(CancellationToken ct) -> Task<int> (quantas notificações criou no ciclo).
//   Para cada job fluxo.creator_jobs com status='expired', error_code='queue_expired' e finished_at nas últimas 24 h,
//   cria uma linha em fluxo.user_notifications POR DONO da conta (businesses.owner_profile_id -> profiles.firebase_uid)
//   com id determinístico 'creator-expired-<jobId>' (INSERT ... ON CONFLICT (id) DO NOTHING: nunca duplica),
//   type='creator_job_expired', read=false. done/failed/cancelled/running/queued não geram notificação.
using System.Reflection;
using Fluxo.Api.Infrastructure.Persistence;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Fluxo.Api.Tests;

public sealed class GateFc005NotifierTests
{
    private static DebateApiFactory Api() => new(GateFc.C, settings: GateFc.Settings());

    private static async Task<int> RunOnceAsync(DebateApiFactory factory)
    {
        using var scope = factory.Services.CreateScope();
        var notifier = scope.ServiceProvider.GetServices<IHostedService>()
            .Single(hosted => hosted.GetType().Name == "CreatorJobExpiryNotifier");
        var method = notifier.GetType().GetMethod("RunOnceAsync")
            ?? throw new Xunit.Sdk.XunitException("CreatorJobExpiryNotifier sem RunOnceAsync(ct) público");
        var task = (Task)method.Invoke(notifier, [CancellationToken.None])!;
        await task;
        return (int)task.GetType().GetProperty("Result")!.GetValue(task)!;
    }


    private static async Task<Guid> SeedExpiredJob(string business, string status, string errorCode, int ageDays = 0)
    {
        var jobId = Guid.NewGuid();
        var nowOrAge = status == "expired" && ageDays > 0
            ? $"now() - make_interval(days => {ageDays})"
            : "now()";
        var finished = status is "done" or "failed" or "expired" or "cancelled" ? nowOrAge : "NULL";
        // running exige lease (ck_creator_jobs_running_has_lease).
        var lease = status == "running" ? "'gate-worker', now() + interval '1 minute'" : "NULL, NULL";
        await DebateTestDb.ExecAsync(GateFc.C, $"""
            INSERT INTO fluxo.creator_jobs (id, business_id, project_id, kind, lane, priority, status, max_attempts,
                deadline_seconds, expires_at, run_after, created_at, idempotency_key, payload, error_code, finished_at,
                locked_by, locked_until)
            VALUES ('{jobId}', '{business}', gen_random_uuid(), 'strategy', 'llm', 1, '{status}', 3, 120,
                now() - interval '1 minute', now(), {nowOrAge}, '{Guid.NewGuid()}', 'null'::jsonb,
                NULLIF('{errorCode}', '-'), {finished}, {lease})
            """);
        return jobId;
    }

    private static async Task<(int Count, string Type, string User)> NotificationAsync(Guid jobId)
    {
        var rows = await GateFc2.RowAsync($"""
            SELECT count(*)::text, coalesce(max(type), '-'), coalesce(max(user_uid), '-')
            FROM fluxo.user_notifications WHERE id = 'creator-expired-{jobId}'
            """);
        return (int.Parse(rows[0]), rows[1], rows[2]);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Expired_queue_job_notifies_each_owner_once_with_a_deterministic_id()
    {
        var (factory, business) = await SetupAsync();
        var jobId = await SeedExpiredJob(business, "expired", "queue_expired");
        var ownerRow = await GateFc2.RowAsync($"SELECT p.firebase_uid FROM fluxo.businesses b JOIN fluxo.profiles p ON b.owner_profile_id = p.id WHERE b.id = '{business}'");
        var owner = ownerRow[0];

        await RunOnceAsync(factory); // o ciclo pode rodar antes ou depois dos ciclos em background: id determinístico decide
        var (count, type, user) = await NotificationAsync(jobId);
        Assert.Equal(1, count);
        Assert.Equal("creator_job_expired", type);
        Assert.Equal(owner, user);

        await RunOnceAsync(factory); // segundo ciclo não duplica (id determinístico + ON CONFLICT)
        var (countAgain, _, _) = await NotificationAsync(jobId);
        Assert.Equal(1, countAgain);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Terminal_and_non_expired_states_are_never_notified()
    {
        var (factory, business) = await SetupAsync();
        var done = await SeedExpiredJob(business, "done", "-");
        var failed = await SeedExpiredJob(business, "failed", "provider_500");
        var cancelled = await SeedExpiredJob(business, "cancelled", "cancelled_by_user");
        var queued = await SeedExpiredJob(business, "queued", "-");
        var running = await SeedExpiredJob(business, "running", "-");

        Assert.Equal(0, await RunOnceAsync(factory));
        foreach (var id in new[] { done, failed, cancelled, queued, running })
            Assert.Equal(0, (await NotificationAsync(id)).Count);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Expiry_older_than_one_day_is_ignored()
    {
        var (factory, business) = await SetupAsync();
        var jobId = await SeedExpiredJob(business, "expired", "queue_expired", ageDays: 2);

        Assert.Equal(0, await RunOnceAsync(factory));
        Assert.Equal(0, (await NotificationAsync(jobId)).Count);
    }

    private static async Task<(DebateApiFactory Factory, string Business)> SetupAsync()
    {
        var (id, _) = await GateFc.SeedBusinessAsync();
        return (Api(), id);
    }
}
