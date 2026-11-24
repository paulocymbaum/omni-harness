// Gate DV-008-API-JOURNEY. Template do autor de gates: copiado para backend/tests/Fluxo.Api.Tests só durante o gate.
// Caminho real: escrita de domínio -> DebateTimelineSignal (DV-002) -> outbox -> DebateOutboxPump com os handlers
// registrados pelo módulo -> snapshot -> GET /api/v1/debates/{slug}/timeline (CPF verificado no emulador Firestore).
// Banco descartável próprio (o banco de teste compartilhado acumula outbox sem handler de execuções anteriores).
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using Fluxo.Api.Infrastructure.Messaging;
using Fluxo.Api.Modules.Debates;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace Fluxo.Api.Tests;

public sealed class Dv008ScratchDb : IAsyncLifetime
{
    public string Connection { get; private set; } = "";

    public async Task InitializeAsync()
    {
        Connection = await DebateTestDb.CreateScratchDatabaseAsync("dv008_tl");
        await DebateTestDb.InstallVectorAsync(Connection);
        await using var db = DebateTestDb.Context(Connection);
        await db.Database.MigrateAsync();
    }

    public Task DisposeAsync() => DebateTestDb.DropScratchDatabaseAsync(Connection);
}

public sealed class DebateDv008TimelineGateTests(Dv008ScratchDb scratch) : IClassFixture<Dv008ScratchDb>
{
    private static readonly string[] Forbidden =
        ["assigned_to", "author_uid", "ai_run_id", "confidence", "change_reason", "editor-seed", "validator-seed", "worker-seed"];

    private sealed record Ctx(DebateApiFactory Factory, HttpClient Reader, DebateOutboxPump Pump);

    private async Task<Ctx> ContextAsync()
    {
        var factory = new DebateApiFactory(scratch.Connection);
        var uid = $"tl-reader-{Guid.NewGuid():N}";
        await PersonVerificationReaderTests.SeedAsync(uid, "verified");
        var pump = new DebateOutboxPump(factory.Services.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(new DebateOptions()), Options.Create(new OutboxDispatcherOptions()), TimeProvider.System,
            NullLogger<DebateOutboxPump>.Instance);
        return new Ctx(factory, factory.Client($"user:{uid}"), pump);
    }

    private async Task<LiveCheck> LiveAsync(Fluxo.Api.Infrastructure.Persistence.FluxoDbContext db, bool isTest = false,
        DebatePublicMode mode = DebatePublicMode.Live)
    {
        var live = await DebateSeed.LiveCheckAsync(db, isTest);
        live.Debate.SetPublicMode(mode);
        await db.SaveChangesAsync();
        await SignalAsync(db, live.Debate);
        return live;
    }

    private static async Task SignalAsync(Fluxo.Api.Infrastructure.Persistence.FluxoDbContext db, Debate debate)
    {
        await using var tx = await db.Database.BeginTransactionAsync();
        await DebateTimelineSignal.Raise(db, debate, DebateSeed.Now);
        await db.SaveChangesAsync();
        await tx.CommitAsync();
    }

    private async Task<long> SnapshotVersion(Guid debateId) =>
        await DebateTestDb.ScalarAsync<long?>(scratch.Connection,
            $"SELECT version FROM fluxo.debate_timeline_snapshots WHERE debate_id = '{debateId}'") ?? -1;

    private async Task<long> TimelineVersion(Guid debateId) =>
        await DebateTestDb.ScalarAsync<long>(scratch.Connection, $"SELECT timeline_version FROM fluxo.debates WHERE id = '{debateId}'");

    /// <summary>Roda a bomba até o snapshot do debate alcançar timeline_version.</summary>
    private async Task PumpAsync(Ctx c, Guid debateId)
    {
        var target = await TimelineVersion(debateId);
        for (var i = 0; i < 20 && await SnapshotVersion(debateId) < target; i++) await c.Pump.DispatchPendingAsync(default);
        Assert.Equal(target, await SnapshotVersion(debateId));
    }

    private static async Task<(HttpResponseMessage Response, JsonElement Json, string Text)> TimelineAsync(HttpClient client,
        string slug, string? etag = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, $"/api/v1/debates/{slug}/timeline");
        if (etag is not null) request.Headers.TryAddWithoutValidation("If-None-Match", etag);
        var response = await client.SendAsync(request);
        var text = await response.Content.ReadAsStringAsync();
        var json = response.StatusCode == HttpStatusCode.OK ? JsonDocument.Parse(text).RootElement.Clone() : default;
        return (response, json, text);
    }

    private static JsonElement? FactCheck(JsonElement timeline, Guid checkId)
    {
        foreach (var e in timeline.GetProperty("events").EnumerateArray())
        {
            if (e.TryGetProperty("fact_check", out var fc) && fc.ValueKind == JsonValueKind.Object &&
                string.Equals(fc.GetProperty("id").GetString(), checkId.ToString(), StringComparison.OrdinalIgnoreCase))
                return fc.Clone();
        }
        return null;
    }

    private static int Cards(JsonElement timeline, Guid participantId, string verdict) =>
        timeline.GetProperty("scoreboard").EnumerateArray()
            .Single(s => string.Equals(s.GetProperty("participant_id").GetString(), participantId.ToString(), StringComparison.OrdinalIgnoreCase))
            .GetProperty("cards").GetProperty(verdict).GetInt32();

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Balloon_carries_only_ai_preview_until_validation_then_card_counts_on_scoreboard()
    {
        var c = await ContextAsync();
        await using var _ = c.Factory;
        await using var db = DebateTestDb.Context(scratch.Connection);
        var live = await LiveAsync(db);
        var second = DebateParticipant.Create(live.Debate.Id, ParticipantRole.Candidate, 2, "Candidato B", "PFY", 20, DebateSeed.Now);
        db.DebateParticipants.Add(second);
        await db.SaveChangesAsync();

        await PumpAsync(c, live.Debate.Id);
        var (pendingResponse, pending, _) = await TimelineAsync(c.Reader, live.Debate.Slug);
        Assert.Equal(HttpStatusCode.OK, pendingResponse.StatusCode);
        Assert.Null(FactCheck(pending, live.Check.Id));
        Assert.Contains(pending.GetProperty("events").EnumerateArray(), e => e.GetProperty("type").GetString() == "claim" &&
            e.GetProperty("verdict").GetString() == "pending" && e.GetProperty("fact_check").ValueKind == JsonValueKind.Null);

        await DebateSeed.AiDraftAsync(db, live.Debate, live.Check, Verdict.False);
        await PumpAsync(c, live.Debate.Id);
        var (response, balloon, text) = await TimelineAsync(c.Reader, live.Debate.Slug);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(1, balloon.GetProperty("schema_version").GetInt32());
        var version = await SnapshotVersion(live.Debate.Id);
        Assert.Equal(version, balloon.GetProperty("version").GetInt64());
        Assert.NotNull(response.Headers.ETag);
        Assert.True(response.Headers.ETag!.IsWeak);
        Assert.Equal($"\"{live.Debate.Id}-{version}\"", response.Headers.ETag.Tag, ignoreCase: true);
        Assert.True(response.Headers.CacheControl is { Private: true, NoCache: true }, $"Cache-Control: {response.Headers.CacheControl}");
        var fc = FactCheck(balloon, live.Check.Id) ?? throw new Xunit.Sdk.XunitException($"balão ausente: {text}");
        Assert.Equal("balloon", fc.GetProperty("display").GetString());
        Assert.Equal("false", fc.GetProperty("ai_preview").GetProperty("verdict").GetString());
        Assert.False(string.IsNullOrWhiteSpace(fc.GetProperty("disclaimer").GetString()));
        Assert.False(fc.TryGetProperty("check", out var noCheck) && noCheck.ValueKind != JsonValueKind.Null, "balão não leva check");
        Assert.False(fc.TryGetProperty("validated_at", out var noAt) && noAt.ValueKind != JsonValueKind.Null, "balão não leva validated_at");
        Assert.Equal(0, Cards(balloon, live.Participant.Id, "false"));
        foreach (var word in Forbidden) Assert.DoesNotContain(word, text, StringComparison.OrdinalIgnoreCase);

        await DebateValidation.ValidateDirectAsync(db, live.Check, Verdict.True);
        await SignalAsync(db, live.Debate);
        await PumpAsync(c, live.Debate.Id);
        var (_, card, cardText) = await TimelineAsync(c.Reader, live.Debate.Slug);
        var validated = FactCheck(card, live.Check.Id) ?? throw new Xunit.Sdk.XunitException($"card ausente: {cardText}");
        Assert.Equal("card", validated.GetProperty("display").GetString());
        Assert.Equal("true", validated.GetProperty("check").GetProperty("verdict").GetString());
        Assert.Equal(JsonValueKind.String, validated.GetProperty("validated_at").ValueKind);
        Assert.False(validated.TryGetProperty("ai_preview", out var noPreview) && noPreview.ValueKind != JsonValueKind.Null, "card não leva ai_preview");
        Assert.Equal(1, Cards(card, live.Participant.Id, "true"));
        Assert.Equal(new[] { live.Participant.Id.ToString(), second.Id.ToString() },
            card.GetProperty("scoreboard").EnumerateArray().Select(s => s.GetProperty("participant_id").GetString()!.ToLowerInvariant()).ToArray());
        foreach (var word in Forbidden) Assert.DoesNotContain(word, cardText, StringComparison.OrdinalIgnoreCase);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Not_validated_and_expired_on_end_disappear_from_timeline()
    {
        var c = await ContextAsync();
        await using var _ = c.Factory;
        await using var db = DebateTestDb.Context(scratch.Connection);
        var live = await LiveAsync(db);
        await DebateSeed.AiDraftAsync(db, live.Debate, live.Check);
        var (_, other) = await DebateSeed.AddCheckAsync(db, live.Debate, live.Participant, 5, "A obra custou 2 bilhões");
        await DebateSeed.AiDraftAsync(db, live.Debate, other);
        await PumpAsync(c, live.Debate.Id);
        var (_, before, beforeText) = await TimelineAsync(c.Reader, live.Debate.Slug);
        Assert.True(FactCheck(before, live.Check.Id) is not null && FactCheck(before, other.Id) is not null, beforeText);

        DebateFactCheckStateMachine.NotValidate(live.Check, live.Debate, DebateSeed.Now);
        await db.SaveChangesAsync();
        await SignalAsync(db, live.Debate);
        await PumpAsync(c, live.Debate.Id);
        var (_, afterNot, afterNotText) = await TimelineAsync(c.Reader, live.Debate.Slug);
        Assert.True(FactCheck(afterNot, live.Check.Id) is null, $"não validada continua no JSON: {afterNotText}");
        Assert.NotNull(FactCheck(afterNot, other.Id));

        await using (var tx = await db.Database.BeginTransactionAsync())
        {
            await DebateLifecycle.EndAsync(db, live.Debate, new DebateActor("operator-seed", "admin"), DebateSeed.Now, default);
            await db.SaveChangesAsync();
            await tx.CommitAsync();
        }
        await PumpAsync(c, live.Debate.Id);
        var (_, ended, endedText) = await TimelineAsync(c.Reader, live.Debate.Slug);
        Assert.True(FactCheck(ended, other.Id) is null, $"balão expirado no /end continua no JSON: {endedText}");
        Assert.Equal("ended", ended.GetProperty("debate").GetProperty("status").GetString());
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Same_etag_returns_304_without_body()
    {
        var c = await ContextAsync();
        await using var _ = c.Factory;
        await using var db = DebateTestDb.Context(scratch.Connection);
        var live = await LiveAsync(db);
        await PumpAsync(c, live.Debate.Id);
        var (first, _, _) = await TimelineAsync(c.Reader, live.Debate.Slug);
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        var etag = first.Headers.ETag?.ToString() ?? throw new Xunit.Sdk.XunitException("200 sem ETag");
        var (second, _, body) = await TimelineAsync(c.Reader, live.Debate.Slug, etag);
        Assert.Equal(HttpStatusCode.NotModified, second.StatusCode);
        Assert.Equal("", body);
        var (other, _, _) = await TimelineAsync(c.Reader, live.Debate.Slug, "W/\"outro-1\"");
        Assert.Equal(HttpStatusCode.OK, other.StatusCode);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Test_and_hidden_debates_return_404_on_reader_timeline()
    {
        var c = await ContextAsync();
        await using var _ = c.Factory;
        await using var db = DebateTestDb.Context(scratch.Connection);
        var visible = await LiveAsync(db);
        var test = await LiveAsync(db, isTest: true);
        var hidden = await LiveAsync(db, mode: DebatePublicMode.Hidden);
        foreach (var d in new[] { visible, test, hidden }) await PumpAsync(c, d.Debate.Id);

        var (ok, _, _) = await TimelineAsync(c.Reader, visible.Debate.Slug);
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        foreach (var slug in new[] { test.Debate.Slug, hidden.Debate.Slug, $"inexistente-{Guid.NewGuid():N}" })
        {
            var (response, _, text) = await TimelineAsync(c.Reader, slug);
            Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
            Assert.Equal("debate_not_found", JsonDocument.Parse(text).RootElement.GetProperty("code").GetString());
        }
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Admin_mirror_serves_snapshot_of_test_debate_to_operate_or_review()
    {
        var c = await ContextAsync();
        await using var _ = c.Factory;
        await using var db = DebateTestDb.Context(scratch.Connection);
        var test = await LiveAsync(db, isTest: true);
        await DebateSeed.AiDraftAsync(db, test.Debate, test.Check);
        await PumpAsync(c, test.Debate.Id);
        foreach (var permission in new[] { "debates.operate", "debates.review" })
        {
            var uid = $"tl-admin-{Guid.NewGuid():N}";
            c.Factory.Registry.Grant(uid, "admin", permission);
            using var admin = c.Factory.Client(DebateApiFactory.Admin(uid));
            using var response = await admin.GetAsync($"/api/v1/admin/debates/{test.Debate.Id}/timeline");
            var text = await response.Content.ReadAsStringAsync();
            Assert.True(response.StatusCode == HttpStatusCode.OK, $"{permission}: {response.StatusCode} {text}");
            var json = JsonDocument.Parse(text).RootElement;
            Assert.Equal(test.Debate.Slug, json.GetProperty("debate").GetProperty("slug").GetString());
            Assert.Equal("balloon", FactCheck(json, test.Check.Id)?.GetProperty("display").GetString());
        }
        var none = $"tl-none-{Guid.NewGuid():N}";
        c.Factory.Registry.Grant(none, "admin", "debates.manage");
        using var denied = c.Factory.Client(DebateApiFactory.Admin(none));
        using var forbidden = await denied.GetAsync($"/api/v1/admin/debates/{test.Debate.Id}/timeline");
        Assert.Equal(HttpStatusCode.Forbidden, forbidden.StatusCode);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Burst_merges_into_latest_version_and_stale_message_never_regresses()
    {
        var c = await ContextAsync();
        await using var _ = c.Factory;
        await using var db = DebateTestDb.Context(scratch.Connection);
        var live = await LiveAsync(db);
        await SignalAsync(db, live.Debate);
        await SignalAsync(db, live.Debate);
        await PumpAsync(c, live.Debate.Id);
        var latest = await TimelineVersion(live.Debate.Id);
        Assert.Equal(latest, await SnapshotVersion(live.Debate.Id));
        var generatedAt = await DebateTestDb.ScalarAsync<DateTime>(scratch.Connection,
            $"SELECT generated_at FROM fluxo.debate_timeline_snapshots WHERE debate_id = '{live.Debate.Id}'");

        db.OutboxMessages.Add(OutboxMessage.Create("Debate", live.Debate.Id.ToString("D"), DebateTimelineSignal.MessageType,
            new { debate_id = live.Debate.Id, version = 1L }, DebateSeed.Now));
        await db.SaveChangesAsync();
        await c.Pump.DispatchPendingAsync(default);
        Assert.Equal(latest, await SnapshotVersion(live.Debate.Id));
        Assert.Equal(generatedAt, await DebateTestDb.ScalarAsync<DateTime>(scratch.Connection,
            $"SELECT generated_at FROM fluxo.debate_timeline_snapshots WHERE debate_id = '{live.Debate.Id}'"));
        var pendingMessages = await DebateTestDb.ScalarAsync<long>(scratch.Connection,
            $"SELECT count(*) FROM fluxo.outbox_messages WHERE aggregate_id = '{live.Debate.Id:D}' AND processed_at IS NULL");
        Assert.Equal(0, pendingMessages);
    }
}
