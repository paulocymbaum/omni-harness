// Gate DV-009-REVISION-LINKS. Template do autor de gates: copiado para backend/tests/Fluxo.Api.Tests só durante o gate.
// Caminho real pelos endpoints internos do worker (OIDC da SA fluxo-debate-worker):
//   POST /internal/debates/{id}/revised-utterances  { providerJobId, asrModel, utterances: [...] }
//   POST /internal/debates/{id}/reprocess:complete  { audioSeconds, providerJobId }
// Cada fala revisada vai com offsets em segundos desde started_at (startS/endS) e, de forma equivalente, como
// captureStartedAt = started_at + startMs/endMs (o mesmo formato da fala ao vivo); qualquer das leituras dá o mesmo offset.
using System.Net;
using Fluxo.Api.Modules.Debates;
using Microsoft.EntityFrameworkCore;

namespace Fluxo.Api.Tests;

public sealed class DebateDv009RevisionGateTests
{
    private sealed record Ctx(DebateApiFactory Factory, LiveCheck Live, DebateUtterance Second, Guid PublicRevision, HttpClient Worker,
        HttpClient Admin);

    private static async Task<Ctx> ReprocessingAsync()
    {
        await DebateTestDb.EnsureAsync();
        await using var db = DebateTestDb.Context();
        var live = await DebateSeed.LiveCheckAsync(db);
        await DebateValidation.ValidateDirectAsync(db, live.Check, Verdict.False);
        var second = DebateSeed.Utterance(live.Debate, live.Participant, "Vamos falar de saúde agora", seq: 2, start: 20);
        db.DebateUtterances.Add(second);
        await db.SaveChangesAsync();
        DebateStateMachine.End(live.Debate, DebateSeed.Now);
        DebateStateMachine.BeginReprocess(live.Debate, DebateSeed.Now);
        await db.SaveChangesAsync();
        await db.Entry(live.Check).ReloadAsync();
        Assert.NotNull(live.Check.PublicRevisionId);
        var factory = new DebateApiFactory(DebateTestDb.Connection);
        var uid = $"rp-{Guid.NewGuid():N}";
        factory.Registry.Grant(uid, "admin", "debates.manage", "debates.operate", "debates.review", "debates.publish");
        return new Ctx(factory, live, second, live.Check.PublicRevisionId!.Value, factory.Client(WorkerTokens.Create()),
            factory.Client(DebateApiFactory.Admin(uid)));
    }

    private static object Revised(Debate debate, long seq, decimal start, decimal end, string text) => new
    {
        seq, speakerLabel = "S1", startS = start, endS = end,
        captureStartedAt = debate.StartedAt, startMs = (long)(start * 1000), endMs = (long)(end * 1000),
        text, confidence = 0.95, asrProvider = "soniox", asrModel = "stt-async-v5"
    };

    private static async Task PostRevisedAsync(Ctx c, string job, params object[] utterances)
    {
        using var response = await DebateApiFactory.SendAsync(c.Worker, HttpMethod.Post,
            $"/api/v1/internal/debates/{c.Live.Debate.Id}/revised-utterances",
            new { providerJobId = job, asrProvider = "soniox", asrModel = "stt-async-v5", utterances });
        Assert.True(response.IsSuccessStatusCode, $"revised-utterances: {(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
    }

    private static async Task CompleteAsync(Ctx c, string job)
    {
        using var response = await DebateApiFactory.SendAsync(c.Worker, HttpMethod.Post,
            $"/api/v1/internal/debates/{c.Live.Debate.Id}/reprocess:complete", new { audioSeconds = 1500, providerJobId = job });
        Assert.True(response.IsSuccessStatusCode, $"reprocess:complete: {(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Revised_utterances_keep_claim_and_check_links_and_never_touch_live()
    {
        var c = await ReprocessingAsync();
        await using var _f = c.Factory;
        var job = $"soniox-{Guid.NewGuid():N}";
        await PostRevisedAsync(c, job,
            Revised(c.Live.Debate, 1, 10.2m, 14.1m, "O desemprego caiu para 5,3%."),
            Revised(c.Live.Debate, 2, 20.1m, 24.0m, "Vamos falar de saúde agora."));
        await CompleteAsync(c, job);

        await using var db = DebateTestDb.Context();
        var debate = await db.Debates.AsNoTracking().SingleAsync(x => x.Id == c.Live.Debate.Id);
        Assert.Equal(DebateStatus.Revised, debate.Status);
        var all = await db.DebateUtterances.AsNoTracking().Where(x => x.DebateId == debate.Id).ToListAsync();
        var live = all.Where(x => x.Origin == UtteranceOrigin.Live).OrderBy(x => x.Seq).ToList();
        Assert.Equal([c.Live.Claim.UtteranceId, c.Second.Id], live.Select(x => x.Id).ToArray());
        Assert.Equal(["O desemprego caiu para 5,3%", "Vamos falar de saúde agora"], live.Select(x => x.Text).ToArray());
        var revised = all.Where(x => x.Origin == UtteranceOrigin.Revised).OrderBy(x => x.StartS).ToList();
        Assert.Equal(2, revised.Count);
        Assert.All(revised, r => Assert.Equal("soniox", r.AsrProvider));
        Assert.Equal(c.Live.Claim.UtteranceId, revised[0].RevisionOf);
        Assert.Equal(c.Second.Id, revised[1].RevisionOf);
        Assert.Equal(c.Live.Participant.Id, revised[0].ParticipantId);

        var claim = await db.DebateClaims.AsNoTracking().SingleAsync(x => x.Id == c.Live.Claim.Id);
        Assert.Equal(c.Live.Claim.UtteranceId, claim.UtteranceId);
        var check = await db.DebateFactChecks.AsNoTracking().SingleAsync(x => x.Id == c.Live.Check.Id);
        Assert.Equal(c.Live.Claim.Id, check.ClaimId);
        Assert.Equal(c.PublicRevision, check.PublicRevisionId);
        Assert.Equal(FactCheckState.Validated, check.State);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Reprocess_rerun_with_same_provider_job_is_idempotent()
    {
        var c = await ReprocessingAsync();
        await using var _f = c.Factory;
        var job = $"soniox-{Guid.NewGuid():N}";
        var batch = new[] { Revised(c.Live.Debate, 1, 10.2m, 14.1m, "O desemprego caiu para 5,3%."),
            Revised(c.Live.Debate, 2, 20.1m, 24.0m, "Vamos falar de saúde agora.") };
        await PostRevisedAsync(c, job, batch);
        await PostRevisedAsync(c, job, batch);
        await CompleteAsync(c, job);

        await using var db = DebateTestDb.Context();
        var origins = await db.DebateUtterances.AsNoTracking().Where(x => x.DebateId == c.Live.Debate.Id)
            .GroupBy(x => x.Origin).Select(g => new { g.Key, Count = g.Count() }).ToListAsync();
        Assert.Equal(2, origins.Single(x => x.Key == UtteranceOrigin.Revised).Count);
        Assert.Equal(2, origins.Single(x => x.Key == UtteranceOrigin.Live).Count);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Revised_text_diverging_in_number_creates_quote_mismatch_without_changing_card()
    {
        var c = await ReprocessingAsync();
        await using var _f = c.Factory;
        var job = $"soniox-{Guid.NewGuid():N}";
        await PostRevisedAsync(c, job, Revised(c.Live.Debate, 1, 10.2m, 14.1m, "O desemprego caiu para 5,8%."));
        await CompleteAsync(c, job);

        var mismatches = await DebateTestDb.ScalarAsync<long>(DebateTestDb.Connection,
            $"SELECT count(*) FROM fluxo.debate_editorial_actions WHERE debate_id = '{c.Live.Debate.Id}' AND action = 'quote_mismatch'");
        Assert.True(mismatches >= 1, "texto revisado com número diferente da citação do card validado gera quote_mismatch");
        await using var db = DebateTestDb.Context();
        var check = await db.DebateFactChecks.AsNoTracking().SingleAsync(x => x.Id == c.Live.Check.Id);
        Assert.Equal(c.PublicRevision, check.PublicRevisionId);
        Assert.Equal(FactCheckState.Validated, check.State);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Reprocess_outside_ended_returns_409_invalid_state()
    {
        await DebateTestDb.EnsureAsync();
        await using var db = DebateTestDb.Context();
        var live = await DebateSeed.LiveCheckAsync(db);
        await using var factory = new DebateApiFactory(DebateTestDb.Connection);
        var uid = $"rp-{Guid.NewGuid():N}";
        factory.Registry.Grant(uid, "admin", "debates.manage");
        using var response = await DebateApiFactory.SendAsync(factory.Client(DebateApiFactory.Admin(uid)), HttpMethod.Post,
            $"/api/v1/admin/debates/{live.Debate.Id}/reprocess", new { });
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("invalid_state", await DebateApiFactory.CodeAsync(response));
    }
}
