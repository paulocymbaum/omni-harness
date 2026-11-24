// Gate DV-008-MANUAL-QUEUE (pendências herdadas da DV-007).
// Template do autor de gates: copiado para backend/tests/Fluxo.Api.Tests só durante o gate.
// 1. LockView.holder e authorDisplayName passam a trazer o nome de exibição do admin (admin_access/{uid} ou perfil);
//    holderUid traz o uid (aditivo). Aqui o nome vem do perfil (fluxo.profiles), sem documento admin_access.
// 2. queue=manual_pending traz ManualDraft e as not_validated sem checagem manual nem descarte.
using System.Net;
using System.Text.Json;
using Fluxo.Api.Modules.Debates;

namespace Fluxo.Api.Tests;

public sealed class DebateDv008ManualQueueGateTests
{
    private static async Task<JsonElement> Json(HttpResponseMessage response)
    {
        var text = await response.Content.ReadAsStringAsync();
        Assert.True(response.IsSuccessStatusCode, $"{response.StatusCode}: {text}");
        return JsonDocument.Parse(text).RootElement.Clone();
    }

    private static Task<HttpResponseMessage> Post(HttpClient client, string route, object? body = null) =>
        DebateApiFactory.SendAsync(client, HttpMethod.Post, route, body);

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Manual_pending_queue_lists_manual_drafts_and_orphan_not_validated_checks()
    {
        await DebateTestDb.EnsureAsync();
        await using var db = DebateTestDb.Context();
        var live = await DebateSeed.LiveCheckAsync(db);
        await DebateSeed.AiDraftAsync(db, live.Debate, live.Check);
        DebateFactCheckStateMachine.NotValidate(live.Check, live.Debate, DebateSeed.Now);
        await db.SaveChangesAsync();
        var (_, withManual) = await DebateSeed.AddCheckAsync(db, live.Debate, live.Participant, 3, "A obra custou 2 bilhões");
        await DebateSeed.AiDraftAsync(db, live.Debate, withManual);
        var (_, discarded) = await DebateSeed.AddCheckAsync(db, live.Debate, live.Participant, 4, "A inflação dobrou");
        await DebateSeed.AiDraftAsync(db, live.Debate, discarded);

        await using var factory = new DebateApiFactory(DebateTestDb.Connection);
        var uid = $"mq-{Guid.NewGuid():N}";
        factory.Registry.Grant(uid, "admin", "debates.review", "debates.publish");
        using var client = factory.Client(DebateApiFactory.Admin(uid));
        Guid manualId;
        await (await Post(client, $"/api/v1/admin/fact-checks/{withManual.Id}:claim")).Content.ReadAsStringAsync();
        using (var manual = await Post(client, $"/api/v1/admin/fact-checks/{withManual.Id}:not-validate",
                   new { reasonCode = "misread", followUp = "manual_check" }))
            manualId = (await Json(manual)).GetProperty("manualCheckId").GetGuid();
        await (await Post(client, $"/api/v1/admin/fact-checks/{discarded.Id}:claim")).Content.ReadAsStringAsync();
        using (var discard = await Post(client, $"/api/v1/admin/fact-checks/{discarded.Id}:not-validate",
                   new { reasonCode = "weak_sources", reason = "Fontes fracas", followUp = "discard", discardReasonCode = "opinion" }))
            await Json(discard);

        using var queue = await client.GetAsync($"/api/v1/admin/fact-checks?queue=manual_pending&debateId={live.Debate.Id}&limit=100");
        var ids = (await Json(queue)).GetProperty("items").EnumerateArray().Select(x => Guid.Parse(x.GetProperty("id").GetString()!)).ToHashSet();
        Assert.Contains(live.Check.Id, ids);
        Assert.Contains(manualId, ids);
        Assert.DoesNotContain(withManual.Id, ids);
        Assert.DoesNotContain(discarded.Id, ids);
    }
}
