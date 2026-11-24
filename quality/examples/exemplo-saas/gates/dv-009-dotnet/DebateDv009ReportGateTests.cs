// Gate DV-009-REPORT-VALIDATED-ONLY. Template do autor de gates: copiado para backend/tests/Fluxo.Api.Tests só durante o gate.
// Caminho real: POST /admin/debates/{id}/archive (skip_reason) -> snapshot do relatório na mesma transação ->
// GET /admin/debates/{id}/public-report (mesmo JSON do leitor) e GET /debates/{slug}/report (CPF verificado no emulador).
// O relatório só traz checagens com display = card; balão, despublicada e não validada não entram.
using System.Net;
using System.Text.Json;
using Fluxo.Api.Modules.Debates;
using Microsoft.EntityFrameworkCore;

namespace Fluxo.Api.Tests;

public sealed class DebateDv009ReportGateTests
{
    private sealed record Seeded(DebateApiFactory Factory, Debate Debate, Guid Card, Guid Balloon, Guid Unpublished, Guid NotValidated,
        HttpClient Admin);

    private static async Task<Seeded> EndedAsync(bool isTest = false)
    {
        await DebateTestDb.EnsureAsync();
        await using var db = DebateTestDb.Context();
        var live = await DebateSeed.LiveCheckAsync(db, isTest);
        await DebateValidation.ValidateDirectAsync(db, live.Check, Verdict.True);
        var balloon = await DebateSeed.AddCheckAsync(db, live.Debate, live.Participant, 2, "A obra custou 2 bilhões");
        await DebateSeed.AiDraftAsync(db, live.Debate, balloon.Check);
        var unpublished = await DebateSeed.AddCheckAsync(db, live.Debate, live.Participant, 3, "O PIB cresceu 9%");
        await DebateValidation.ValidateDirectAsync(db, unpublished.Check, Verdict.True);
        DebateFactCheckStateMachine.Unpublish(unpublished.Check, DebateSeed.Now);
        var notValidated = await DebateSeed.AddCheckAsync(db, live.Debate, live.Participant, 4, "A inflação é de 2%");
        await DebateSeed.AiDraftAsync(db, live.Debate, notValidated.Check);
        DebateFactCheckStateMachine.NotValidate(notValidated.Check, live.Debate, DebateSeed.Now);
        await db.SaveChangesAsync();
        DebateStateMachine.End(live.Debate, DebateSeed.Now);
        await db.SaveChangesAsync();
        var factory = new DebateApiFactory(DebateTestDb.Connection);
        var uid = $"arc-{Guid.NewGuid():N}";
        factory.Registry.Grant(uid, "admin", "debates.manage", "debates.publish");
        return new Seeded(factory, live.Debate, live.Check.Id, balloon.Check.Id, unpublished.Check.Id, notValidated.Check.Id,
            factory.Client(DebateApiFactory.Admin(uid)));
    }

    private static Task<HttpResponseMessage> ArchiveAsync(Seeded s, string? skipReason) =>
        DebateApiFactory.SendAsync(s.Admin, HttpMethod.Post, $"/api/v1/admin/debates/{s.Debate.Id}/archive",
            skipReason is null ? new { } : new { skipReason, skip_reason = skipReason });

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Public_report_contains_only_validated_cards()
    {
        var s = await EndedAsync();
        await using var _f = s.Factory;
        using (var archive = await ArchiveAsync(s, "áudio do ensaio indisponível"))
            Assert.True(archive.IsSuccessStatusCode, $"archive: {(int)archive.StatusCode} {await archive.Content.ReadAsStringAsync()}");

        using var response = await s.Admin.GetAsync($"/api/v1/admin/debates/{s.Debate.Id}/public-report");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var json = await response.Content.ReadAsStringAsync();
        JsonDocument.Parse(json);
        Assert.Contains(s.Card.ToString(), json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(s.Balloon.ToString(), json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(s.Unpublished.ToString(), json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(s.NotValidated.ToString(), json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("\"balloon\"", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("validator-seed", json, StringComparison.Ordinal);
        Assert.DoesNotContain("editor-seed", json, StringComparison.Ordinal);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Archive_without_revised_and_without_skip_reason_returns_409()
    {
        var s = await EndedAsync();
        await using var _f = s.Factory;
        using var response = await ArchiveAsync(s, null);
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        await using var db = DebateTestDb.Context();
        var debate = await db.Debates.AsNoTracking().SingleAsync(x => x.Id == s.Debate.Id);
        Assert.Equal(DebateStatus.Ended, debate.Status);
        Assert.NotEqual(DebatePublicMode.Archived, debate.PublicMode);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Archive_sets_permanent_mode_saves_skip_reason_signals_timeline_and_requests_cards()
    {
        var s = await EndedAsync();
        await using var _f = s.Factory;
        using (var archive = await ArchiveAsync(s, "áudio do ensaio indisponível"))
            Assert.True(archive.IsSuccessStatusCode, $"archive: {(int)archive.StatusCode} {await archive.Content.ReadAsStringAsync()}");

        await using var db = DebateTestDb.Context();
        var debate = await db.Debates.AsNoTracking().SingleAsync(x => x.Id == s.Debate.Id);
        Assert.Equal(DebateStatus.Archived, debate.Status);
        Assert.Equal(DebatePublicMode.Archived, debate.PublicMode);
        Assert.Equal("áudio do ensaio indisponível", debate.ArchiveSkipReason);
        var id = s.Debate.Id.ToString("D");
        var types = await db.OutboxMessages.AsNoTracking().Where(x => x.AggregateId == id).Select(x => x.Type).ToListAsync();
        Assert.Contains(DebateTimelineSignal.MessageType, types);
        Assert.Contains("debate.cards-requested.v1", types);
        var snapshots = await DebateTestDb.ScalarAsync<long>(DebateTestDb.Connection,
            $"SELECT count(*) FROM fluxo.debate_report_snapshots WHERE debate_id = '{s.Debate.Id}'");
        Assert.Equal(1L, snapshots);
        var actions = await DebateTestDb.ScalarAsync<long>(DebateTestDb.Connection,
            $"SELECT count(*) FROM fluxo.debate_editorial_actions WHERE debate_id = '{s.Debate.Id}' AND action = 'debate_archive'");
        Assert.True(actions >= 1, "archive registra debate_archive em debate_editorial_actions");
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Reader_report_is_404_for_test_debate_and_200_for_archived_debate()
    {
        var real = await EndedAsync();
        var rehearsal = await EndedAsync(isTest: true);
        await using var _r = real.Factory;
        await using var _t = rehearsal.Factory;
        foreach (var s in new[] { real, rehearsal })
            using (var archive = await ArchiveAsync(s, "ensaio sem áudio"))
                Assert.True(archive.IsSuccessStatusCode, $"archive: {(int)archive.StatusCode}");

        var uid = $"rep-reader-{Guid.NewGuid():N}";
        await PersonVerificationReaderTests.SeedAsync(uid, "verified");
        var reader = real.Factory.Client($"user:{uid}");
        using (var ok = await reader.GetAsync($"/api/v1/debates/{real.Debate.Slug}/report"))
        {
            Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
            Assert.Contains(real.Card.ToString(), await ok.Content.ReadAsStringAsync(), StringComparison.OrdinalIgnoreCase);
            Assert.NotNull(ok.Headers.ETag);
        }
        using var hidden = await reader.GetAsync($"/api/v1/debates/{rehearsal.Debate.Slug}/report");
        Assert.Equal(HttpStatusCode.NotFound, hidden.StatusCode);
    }
}
