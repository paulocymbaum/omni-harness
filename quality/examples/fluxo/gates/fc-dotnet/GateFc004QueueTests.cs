// Gates FC-004-IDEMPOTENCIA-DEDUPE, FC-004-CANCELAR e a parte dotnet de FC-004-SEM-HARDCODE (template).
// O lado .NET da fila é lido por reflexão (nome simples dos tipos, como no FC-001), então compila antes de existir. Contrato fixado pelo gate
// a partir da spec: CreatorJobQueue (registrado em DI, scoped) com
//   EnqueueAsync(FluxoDbContext db, CreatorJobRequest request, CancellationToken ct) -> Task<CreatorJobEnqueueResult(Job, Created)>
//   CancelQueuedForProjectAsync(FluxoDbContext db, string businessId, Guid projectId, CancellationToken ct) -> Task<(int cancelled, int running)>
//   JobsAheadAsync(FluxoDbContext db, CreatorJob job, CancellationToken ct) -> Task<int>
// CreatorJobRequest é preenchido por NOME de parâmetro/propriedade (businessId, projectId, slideIndex, kind, priority, payload, idempotencyKey,
// dedupeKey), sem campo de pista: a pista sai de CreatorJobKinds.LaneOf(kind). Enfileirar acontece na transação do chamador (aqui, aberta pelo teste).
using System.Reflection;
using System.Text.Json;
using Fluxo.Api.Infrastructure.Persistence;
using Microsoft.Extensions.DependencyInjection;

namespace Fluxo.Api.Tests;

public sealed class GateFc004QueueTests
{
    private static DebateApiFactory Api(params (string Key, string? Value)[] extra) => new(GateFc.C, settings: GateFc.Settings(extra));

    private static object? Convert(object? value, Type type)
    {
        var target = Nullable.GetUnderlyingType(type) ?? type;
        if (value is null) return null;
        if (target.IsEnum) return GateFc.Pick(target, (string)value);
        if (value is JsonElementText text)
        {
            if (target == typeof(string)) return text.Json;
            if (target == typeof(JsonElement)) return JsonDocument.Parse(text.Json).RootElement.Clone();
            if (target == typeof(JsonDocument)) return JsonDocument.Parse(text.Json);
            if (target == typeof(System.Text.Json.Nodes.JsonNode)) return System.Text.Json.Nodes.JsonNode.Parse(text.Json);
            if (target == typeof(object)) return text.Json;
            throw new Xunit.Sdk.XunitException($"payload do CreatorJobRequest tem tipo {target}: o gate entende string, JsonElement, JsonDocument e JsonNode");
        }
        return target.IsInstanceOfType(value) ? value : System.Convert.ChangeType(value, target, System.Globalization.CultureInfo.InvariantCulture);
    }

    private sealed record JsonElementText(string Json);

    private static object Request(string business, string kind, string key, Guid? project = null, int priority = 1, string? dedupe = null, string payload = "{}", int? slide = null)
    {
        var type = GateFc.Find("CreatorJobRequest");
        var values = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase)
        {
            ["businessId"] = business, ["projectId"] = project ?? Guid.NewGuid(), ["slideIndex"] = slide, ["kind"] = kind, ["priority"] = priority,
            ["payload"] = new JsonElementText(payload), ["idempotencyKey"] = key, ["dedupeKey"] = dedupe,
        };
        Assert.DoesNotContain(type.GetProperties().Select(p => p.Name).Concat(type.GetConstructors().SelectMany(c => c.GetParameters().Select(p => p.Name!))), n => n.Equals("lane", StringComparison.OrdinalIgnoreCase));
        var ctor = type.GetConstructors().OrderByDescending(c => c.GetParameters().Length).FirstOrDefault();
        if (ctor is not null && ctor.GetParameters().Length > 0)
        {
            var args = ctor.GetParameters().Select(p =>
            {
                if (values.TryGetValue(p.Name!, out var v)) return Convert(v, p.ParameterType);
                Assert.True(p.HasDefaultValue || !p.ParameterType.IsValueType, $"CreatorJobRequest.{p.Name} sem valor no gate");
                return p.HasDefaultValue ? p.DefaultValue : null;
            }).ToArray();
            return ctor.Invoke(args);
        }
        var instance = Activator.CreateInstance(type)!;
        foreach (var property in type.GetProperties().Where(p => p.SetMethod is not null))
            if (values.TryGetValue(property.Name, out var v)) property.SetValue(instance, Convert(v, property.PropertyType));
        return instance;
    }

    private static async Task<(bool Created, Guid Id, object Job)> EnqueueAsync(DebateApiFactory factory, object request)
    {
        using var scope = factory.Services.CreateScope();
        var queue = scope.ServiceProvider.GetRequiredService(GateFc.Find("CreatorJobQueue"));
        await using var db = DebateTestDb.Context();
        await using var tx = await db.Database.BeginTransactionAsync();
        var method = queue.GetType().GetMethod("EnqueueAsync") ?? throw new Xunit.Sdk.XunitException("CreatorJobQueue sem EnqueueAsync");
        var task = (Task)method.Invoke(queue, [db, request, CancellationToken.None])!;
        await task;
        var result = task.GetType().GetProperty("Result")!.GetValue(task)!;
        await db.SaveChangesAsync();
        await tx.CommitAsync();
        var job = result.GetType().GetProperty("Job")!.GetValue(result)!;
        return ((bool)result.GetType().GetProperty("Created")!.GetValue(result)!, (Guid)job.GetType().GetProperty("Id")!.GetValue(job)!, job);
    }

    private static async Task<string[]> RowAsync(Guid id) =>
        await GateFc2.RowAsync($"SELECT status, lane, priority::text, coalesce(error_code,'-'), idempotency_key, coalesce(dedupe_key,'-'), max_attempts::text, deadline_seconds::text FROM fluxo.creator_jobs WHERE id = '{id}'");

    private static async Task<(DebateApiFactory Factory, string Business)> SetupAsync(params (string, string?)[] extra)
    {
        var (id, _) = await GateFc.SeedBusinessAsync();
        return (Api(extra), id);
    }

    // ───────────────────────── IDEMPOTENCIA-DEDUPE ─────────────────────────

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Same_idempotency_key_creates_one_row_and_keys_are_scoped_by_business()
    {
        var (factory, business) = await SetupAsync();
        await using var _f = factory;
        var (other, _) = await GateFc.SeedBusinessAsync();
        var key = $"req-{Guid.NewGuid():N}";
        var first = await EnqueueAsync(factory, Request(business, "strategy", key));
        var again = await EnqueueAsync(factory, Request(business, "strategy", key));
        Assert.True(first.Created);
        Assert.False(again.Created);
        Assert.Equal(first.Id, again.Id);
        Assert.Equal("1", await GateFc2.ScalarAsync($"SELECT count(*) FROM fluxo.creator_jobs WHERE idempotency_key = '{business}:{key}'"));
        Assert.Equal($"{business}:{key}", (await RowAsync(first.Id))[4]);
        var foreign = await EnqueueAsync(factory, Request(other, "strategy", key));
        Assert.True(foreign.Created, "a mesma chave em outra conta não colide");
        Assert.NotEqual(first.Id, foreign.Id);
        Assert.Equal($"{other}:{key}", (await RowAsync(foreign.Id))[4]);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Lane_comes_from_the_kind_and_expiry_attempts_and_deadline_come_from_creator_queue_options()
    {
        var (factory, business) = await SetupAsync((GateFc.KeyOf("MaxAttempts"), "4"), (GateFc.KeyOf("JobExpiryMinutes"), "9"),
            (GateFc.KeyOf("PreviewExpirySeconds"), "7"), (GateFc.KeyOf("JobDeadlineSeconds"), "90"));
        await using var _f = factory;
        foreach (var (kind, lane, priority) in new[] { ("strategy", "llm", 1), ("slide_copy", "llm", 1), ("vision", "llm", 1), ("render", "render", 1), ("preview", "render", 0), ("adapt_viewport", "render", 2) })
        {
            var job = await EnqueueAsync(factory, Request(business, kind, Guid.NewGuid().ToString("N"), priority: priority));
            var row = await RowAsync(job.Id);
            Assert.Equal(["queued", lane, priority.ToString()], row[..3]);
            Assert.Equal(["4", "90"], new[] { row[6], row[7] });
            var seconds = double.Parse((await GateFc2.ScalarAsync($"SELECT extract(epoch FROM expires_at - created_at) FROM fluxo.creator_jobs WHERE id = '{job.Id}'"))!, System.Globalization.CultureInfo.InvariantCulture);
            if (priority == 0) Assert.InRange(seconds, 6, 9);
            else Assert.InRange(seconds, 9 * 60 - 3, 9 * 60 + 3);
            Assert.Null(await GateFc2.ScalarAsync($"SELECT deadline_at FROM fluxo.creator_jobs WHERE id = '{job.Id}'"));
            Assert.Equal("0", await GateFc2.ScalarAsync($"SELECT attempts FROM fluxo.creator_jobs WHERE id = '{job.Id}'"));
        }
        await using var defaults = Api();
        var plain = await EnqueueAsync(defaults, Request(business, "strategy", Guid.NewGuid().ToString("N")));
        Assert.Equal(["3", "120"], new[] { (await RowAsync(plain.Id))[6], (await RowAsync(plain.Id))[7] });
        var minutes = double.Parse((await GateFc2.ScalarAsync($"SELECT extract(epoch FROM expires_at - created_at) FROM fluxo.creator_jobs WHERE id = '{plain.Id}'"))!, System.Globalization.CultureInfo.InvariantCulture) / 60;
        Assert.InRange(minutes, 14.9, 15.1);
        var preview = await EnqueueAsync(defaults, Request(business, "preview", Guid.NewGuid().ToString("N"), priority: 0));
        var previewSeconds = double.Parse((await GateFc2.ScalarAsync($"SELECT extract(epoch FROM expires_at - created_at) FROM fluxo.creator_jobs WHERE id = '{preview.Id}'"))!, System.Globalization.CultureInfo.InvariantCulture);
        Assert.InRange(previewSeconds, 9, 11);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Dedupe_key_cancels_the_queued_job_as_superseded_and_never_touches_a_running_one()
    {
        var (factory, business) = await SetupAsync();
        await using var _f = factory;
        var project = Guid.NewGuid();
        var dedupe = $"preview:{Guid.NewGuid():N}";
        var first = await EnqueueAsync(factory, Request(business, "preview", "a-" + Guid.NewGuid().ToString("N"), project, priority: 0, dedupe: dedupe));
        var second = await EnqueueAsync(factory, Request(business, "preview", "b-" + Guid.NewGuid().ToString("N"), project, priority: 0, dedupe: dedupe));
        Assert.True(second.Created);
        var superseded = await RowAsync(first.Id);
        Assert.Equal(["cancelled", "superseded"], new[] { superseded[0], superseded[3] });
        Assert.NotNull(await GateFc2.ScalarAsync($"SELECT finished_at FROM fluxo.creator_jobs WHERE id = '{first.Id}'"));
        Assert.Equal("queued", (await RowAsync(second.Id))[0]);

        await GateFc2.ScalarAsync($"UPDATE fluxo.creator_jobs SET status='running', attempts=1, locked_by='w1', locked_until=now()+interval '1 minute' WHERE id = '{second.Id}' RETURNING 1");
        var third = await EnqueueAsync(factory, Request(business, "preview", "c-" + Guid.NewGuid().ToString("N"), project, priority: 0, dedupe: dedupe));
        Assert.True(third.Created);
        Assert.Equal("running", (await RowAsync(second.Id))[0]);
        Assert.Equal("queued", (await RowAsync(third.Id))[0]);
        Assert.Equal("1", await GateFc2.ScalarAsync($"SELECT count(*) FROM fluxo.creator_jobs WHERE dedupe_key = '{dedupe}' AND status = 'queued'"));
    }

    // FC-004 D2: repetir o MESMO pedido (mesma idempotency_key) que traz dedupe_key devolve o job vivo; não pode cancelá-lo como superseded.
    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Replaying_an_idempotent_request_that_carries_a_dedupe_key_returns_the_live_job_and_does_not_supersede_it()
    {
        var (factory, business) = await SetupAsync();
        await using var _f = factory;
        var project = Guid.NewGuid();
        var dedupe = $"replay:{Guid.NewGuid():N}";
        var key = $"replay-{Guid.NewGuid():N}";
        var first = await EnqueueAsync(factory, Request(business, "preview", key, project, priority: 0, dedupe: dedupe));
        var replay = await EnqueueAsync(factory, Request(business, "preview", key, project, priority: 0, dedupe: dedupe));
        Assert.True(first.Created);
        Assert.False(replay.Created);
        Assert.Equal(first.Id, replay.Id);
        Assert.Equal("queued", (await RowAsync(first.Id))[0]);
        Assert.Equal("1", await GateFc2.ScalarAsync($"SELECT count(*) FROM fluxo.creator_jobs WHERE dedupe_key = '{dedupe}'"));
        Assert.Equal("0", await GateFc2.ScalarAsync($"SELECT count(*) FROM fluxo.creator_jobs WHERE dedupe_key = '{dedupe}' AND error_code = 'superseded'"));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Racing_enqueues_with_one_dedupe_key_end_with_exactly_one_queued_job_and_no_error()
    {
        var (factory, business) = await SetupAsync();
        await using var _f = factory;
        for (var round = 0; round < 5; round++)
        {
            var dedupe = $"race:{Guid.NewGuid():N}";
            var project = Guid.NewGuid();
            var results = await Task.WhenAll(Enumerable.Range(0, 2).Select(i =>
                EnqueueAsync(factory, Request(business, "preview", $"r{round}-{i}-{Guid.NewGuid():N}", project, priority: 0, dedupe: dedupe))));
            Assert.All(results, r => Assert.True(r.Created));
            Assert.Equal("1", await GateFc2.ScalarAsync($"SELECT count(*) FROM fluxo.creator_jobs WHERE dedupe_key = '{dedupe}' AND status = 'queued'"));
            Assert.Equal("1", await GateFc2.ScalarAsync($"SELECT count(*) FROM fluxo.creator_jobs WHERE dedupe_key = '{dedupe}' AND status = 'cancelled' AND error_code = 'superseded'"));
        }
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Oversized_payload_and_unknown_business_are_refused_without_leaving_a_row()
    {
        var (factory, business) = await SetupAsync();
        await using var _f = factory;
        var key = $"big-{Guid.NewGuid():N}";
        await Assert.ThrowsAnyAsync<Exception>(() => EnqueueAsync(factory, Request(business, "strategy", key, payload: "{\"p\":\"" + new string('x', 70000) + "\"}")));
        Assert.Equal("0", await GateFc2.ScalarAsync($"SELECT count(*) FROM fluxo.creator_jobs WHERE idempotency_key = '{business}:{key}'"));
        var ghost = $"nao-existe-{Guid.NewGuid():N}";
        await Assert.ThrowsAnyAsync<Exception>(() => EnqueueAsync(factory, Request(ghost, "strategy", "g-" + Guid.NewGuid().ToString("N"))));
        Assert.Equal("0", await GateFc2.ScalarAsync($"SELECT count(*) FROM fluxo.creator_jobs WHERE business_id = '{ghost}'"));
        var ok = await EnqueueAsync(factory, Request(business, "strategy", "ok-" + Guid.NewGuid().ToString("N"), payload: "{\"p\":\"" + new string('x', 60000) + "\"}"));
        Assert.True(ok.Created);
    }

    // ───────────────────────── CANCELAR ─────────────────────────

    private static async Task<(int Cancelled, int Running)> CancelAsync(DebateApiFactory factory, string business, Guid project)
    {
        using var scope = factory.Services.CreateScope();
        var queue = scope.ServiceProvider.GetRequiredService(GateFc.Find("CreatorJobQueue"));
        await using var db = DebateTestDb.Context();
        var task = (Task)queue.GetType().GetMethod("CancelQueuedForProjectAsync")!.Invoke(queue, [db, business, project, CancellationToken.None])!;
        await task;
        var tuple = task.GetType().GetProperty("Result")!.GetValue(task)!;
        return ((int)tuple.GetType().GetField("Item1")!.GetValue(tuple)!, (int)tuple.GetType().GetField("Item2")!.GetValue(tuple)!);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Cancel_marks_only_queued_jobs_of_the_project_and_lets_running_ones_finish()
    {
        var (factory, business) = await SetupAsync();
        await using var _f = factory;
        var (other, _) = await GateFc.SeedBusinessAsync();
        var project = Guid.NewGuid();
        var queued1 = await EnqueueAsync(factory, Request(business, "strategy", "q1-" + Guid.NewGuid().ToString("N"), project));
        var queued2 = await EnqueueAsync(factory, Request(business, "render", "q2-" + Guid.NewGuid().ToString("N"), project, slide: 0));
        var running = await EnqueueAsync(factory, Request(business, "slide_copy", "r1-" + Guid.NewGuid().ToString("N"), project, slide: 1));
        var done = await EnqueueAsync(factory, Request(business, "slide_copy", "d1-" + Guid.NewGuid().ToString("N"), project, slide: 2));
        var foreign = await EnqueueAsync(factory, Request(other, "strategy", "f1-" + Guid.NewGuid().ToString("N"), project));
        var otherProject = await EnqueueAsync(factory, Request(business, "strategy", "p2-" + Guid.NewGuid().ToString("N")));
        await GateFc2.ScalarAsync($"UPDATE fluxo.creator_jobs SET status='running', attempts=1, locked_by='w1', locked_until=now()+interval '1 minute' WHERE id = '{running.Id}' RETURNING 1");
        await GateFc2.ScalarAsync($"UPDATE fluxo.creator_jobs SET status='done', finished_at=now() WHERE id = '{done.Id}' RETURNING 1");

        var (cancelled, stillRunning) = await CancelAsync(factory, business, project);
        Assert.Equal((2, 1), (cancelled, stillRunning));
        foreach (var id in new[] { queued1.Id, queued2.Id })
        {
            var row = await RowAsync(id);
            Assert.Equal(["cancelled", "cancelled_by_user"], new[] { row[0], row[3] });
            Assert.NotNull(await GateFc2.ScalarAsync($"SELECT finished_at FROM fluxo.creator_jobs WHERE id = '{id}'"));
        }
        Assert.Equal("running", (await RowAsync(running.Id))[0]);
        Assert.Equal("w1", await GateFc2.ScalarAsync($"SELECT locked_by FROM fluxo.creator_jobs WHERE id = '{running.Id}'"));
        Assert.Equal("done", (await RowAsync(done.Id))[0]);
        Assert.Equal("queued", (await RowAsync(foreign.Id))[0]);
        Assert.Equal("queued", (await RowAsync(otherProject.Id))[0]);
        Assert.Equal((0, 1), await CancelAsync(factory, business, project));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Jobs_ahead_counts_older_queued_jobs_of_the_same_lane_that_are_ready()
    {
        var (factory, business) = await SetupAsync();
        await using var _f = factory;
        var (other, _) = await GateFc.SeedBusinessAsync();
        await GateFc2.ScalarAsync("UPDATE fluxo.creator_jobs SET status='cancelled', error_code='gate_cleanup', finished_at=now() WHERE status='queued' RETURNING 1");
        var a = await EnqueueAsync(factory, Request(business, "strategy", "a-" + Guid.NewGuid().ToString("N")));
        var b = await EnqueueAsync(factory, Request(other, "strategy", "b-" + Guid.NewGuid().ToString("N")));
        var later = await EnqueueAsync(factory, Request(business, "strategy", "c-" + Guid.NewGuid().ToString("N")));
        var render = await EnqueueAsync(factory, Request(business, "render", "d-" + Guid.NewGuid().ToString("N")));
        await GateFc2.ScalarAsync($"UPDATE fluxo.creator_jobs SET run_after = now() + interval '5 minutes' WHERE id = '{b.Id}' RETURNING 1");
        async Task<int> Ahead(object job)
        {
            using var scope = factory.Services.CreateScope();
            var queue = scope.ServiceProvider.GetRequiredService(GateFc.Find("CreatorJobQueue"));
            await using var db = DebateTestDb.Context();
            var task = (Task)queue.GetType().GetMethod("JobsAheadAsync")!.Invoke(queue, [db, job, CancellationToken.None])!;
            await task;
            return (int)task.GetType().GetProperty("Result")!.GetValue(task)!;
        }
        Assert.Equal(0, await Ahead(a.Job));
        Assert.Equal(1, await Ahead(later.Job));
        Assert.Equal(0, await Ahead(render.Job));
    }

    // ───────────────────────── SEM-HARDCODE (parte .NET) ─────────────────────────

    [Fact]
    public void Invalid_creator_queue_options_stop_the_startup()
    {
        GateFc.AssertStartupFails(GateFc.Settings((GateFc.KeyOf("MaxAttempts"), "0")));
        GateFc.AssertStartupFails(GateFc.Settings((GateFc.KeyOf("MaxAttempts"), "11")));
        GateFc.AssertStartupFails(GateFc.Settings((GateFc.KeyOf("JobExpiryMinutes"), "0")));
        GateFc.AssertStartupFails(GateFc.Settings((GateFc.KeyOf("PreviewExpirySeconds"), "0")));
        GateFc.AssertStartupFails(GateFc.Settings((GateFc.KeyOf("JobDeadlineSeconds"), "0")));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Config_response_does_not_gain_queue_fields()
    {
        var (id, owner) = await GateFc.SeedBusinessAsync();
        await using var factory = Api();
        using var client = factory.Client($"user:{owner}");
        var result = await GateFc.GetAsync(client, $"/api/v1/creator/config?businessId={id}");
        Assert.Equal(200, result.Status);
        var names = GateFc.PropertyNames(result.Body).Select(n => n.ToLowerInvariant()).ToArray();
        Assert.Empty(names.Where(n => n.Contains("maxattempts") || n.Contains("jobexpiry") || n.Contains("previewexpiry") || n.Contains("deadline") || n.Contains("queue") && n != "maxqueuedjobsperbusiness"));
        Assert.Equal(1, result.Body.GetProperty("version").GetInt32());
    }
}
