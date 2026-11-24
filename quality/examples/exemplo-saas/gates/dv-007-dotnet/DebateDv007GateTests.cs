// Gate DV-007-DESK-SNAPSHOT (pendência herdada da DV-006). Template do autor de gates: copiado para
// backend/tests/Fluxo.Api.Tests só durante o gate e removido depois.
// O snapshot do SSE da mesa (GET /admin/debates/{id}/stream?once=1) passa a trazer, além de { debate, lastSeq },
// as falas recentes (utterances), as afirmações na fila (claims) e as checagens abertas (factChecks).
// Os nomes dos campos são os que o reducer do admin já lê (admin-web/src/modules/debates/domain/deskState.ts).
using System.Net;
using System.Text.Json;
using Fluxo.Api.Modules.Debates;

namespace Fluxo.Api.Tests;

public sealed class DebateDv007GateTests
{
    private static JsonElement Snapshot(string body)
    {
        foreach (var block in body.Split("\n\n", StringSplitOptions.RemoveEmptyEntries))
        {
            var lines = block.Split('\n');
            if (!lines.Contains("event: snapshot")) continue;
            var data = string.Concat(lines.Where(l => l.StartsWith("data: ", StringComparison.Ordinal)).Select(l => l[6..]));
            return JsonDocument.Parse(data).RootElement.Clone();
        }
        throw new InvalidOperationException($"stream sem snapshot: {body}");
    }

    private static HashSet<string> Ids(JsonElement snapshot, string field, string alt)
    {
        Assert.True(snapshot.TryGetProperty(field, out var list), $"snapshot sem '{field}'");
        Assert.Equal(JsonValueKind.Array, list.ValueKind);
        return list.EnumerateArray()
            .Select(x => x.TryGetProperty("id", out var id) ? id.GetString() : x.TryGetProperty(alt, out var a) ? a.GetString() : null)
            .Where(x => x is not null).Select(x => x!).ToHashSet(StringComparer.OrdinalIgnoreCase);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Desk_snapshot_brings_recent_utterances_claim_queue_and_open_fact_checks()
    {
        await DebateTestDb.EnsureAsync();
        await using var db = DebateTestDb.Context();
        var live = await DebateSeed.LiveCheckAsync(db);
        await DebateSeed.AiDraftAsync(db, live.Debate, live.Check);
        var queuedUtterance = DebateSeed.Utterance(live.Debate, live.Participant, "A obra custou 2 bilhões", seq: 2, start: 30);
        db.DebateUtterances.Add(queuedUtterance);
        await db.SaveChangesAsync();
        var queuedClaim = DebateSeed.Claim(queuedUtterance);
        db.DebateClaims.Add(queuedClaim);
        await db.SaveChangesAsync();

        await using var factory = new DebateApiFactory(DebateTestDb.Connection);
        var uid = $"desk-{Guid.NewGuid():N}";
        factory.Registry.Grant(uid, "admin", "debates.operate", "debates.review");
        var client = factory.Client(DebateApiFactory.Admin(uid));
        using var request = new HttpRequestMessage(HttpMethod.Get, $"/api/v1/admin/debates/{live.Debate.Id}/stream?once=1");
        using var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var snapshot = Snapshot(await response.Content.ReadAsStringAsync());

        Assert.True(snapshot.TryGetProperty("debate", out _), "o snapshot continua com debate (mudança aditiva)");
        Assert.True(snapshot.TryGetProperty("lastSeq", out _), "o snapshot continua com lastSeq (mudança aditiva)");
        var utterances = Ids(snapshot, "utterances", "utteranceId");
        Assert.Contains(live.Claim.UtteranceId.ToString(), utterances);
        Assert.Contains(queuedUtterance.Id.ToString(), utterances);
        Assert.Contains(queuedClaim.Id.ToString(), Ids(snapshot, "claims", "claimId"));
        Assert.Contains(live.Check.Id.ToString(), Ids(snapshot, "factChecks", "factCheckId"));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Desk_snapshot_lists_only_this_debate()
    {
        await DebateTestDb.EnsureAsync();
        await using var db = DebateTestDb.Context();
        var mine = await DebateSeed.LiveCheckAsync(db);
        var other = await DebateSeed.LiveCheckAsync(db);

        await using var factory = new DebateApiFactory(DebateTestDb.Connection);
        var uid = $"desk-{Guid.NewGuid():N}";
        factory.Registry.Grant(uid, "admin", "debates.operate", "debates.review");
        var client = factory.Client(DebateApiFactory.Admin(uid));
        using var request = new HttpRequestMessage(HttpMethod.Get, $"/api/v1/admin/debates/{mine.Debate.Id}/stream?once=1");
        using var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var snapshot = Snapshot(await response.Content.ReadAsStringAsync());

        var utterances = Ids(snapshot, "utterances", "utteranceId");
        Assert.Contains(mine.Claim.UtteranceId.ToString(), utterances);
        Assert.DoesNotContain(other.Claim.UtteranceId.ToString(), utterances);
        var checks = Ids(snapshot, "factChecks", "factCheckId");
        Assert.Contains(mine.Check.Id.ToString(), checks);
        Assert.DoesNotContain(other.Check.Id.ToString(), checks);
    }
}
