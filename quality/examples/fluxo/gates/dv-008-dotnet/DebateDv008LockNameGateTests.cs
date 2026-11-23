// Gate DV-008-LOCK-DISPLAY-NAME (pendências herdadas da DV-007).
// Template do autor de gates: copiado para backend/tests/Fluxo.Api.Tests só durante o gate.
// 1. LockView.holder e authorDisplayName passam a trazer o nome de exibição do admin (admin_access/{uid} ou perfil);
//    holderUid traz o uid (aditivo). Aqui o nome vem do perfil (fluxo.profiles), sem documento admin_access.
// 2. queue=manual_pending traz ManualDraft e as not_validated sem checagem manual nem descarte.
using System.Net;
using System.Text.Json;
using Fluxo.Api.Modules.Debates;
using Fluxo.Api.Modules.Profiles;

namespace Fluxo.Api.Tests;

public sealed class DebateDv008LockNameGateTests
{
    private static async Task<JsonElement> Json(HttpResponseMessage response)
    {
        var text = await response.Content.ReadAsStringAsync();
        Assert.True(response.IsSuccessStatusCode, $"{response.StatusCode}: {text}");
        return JsonDocument.Parse(text).RootElement.Clone();
    }

    private static Task<HttpResponseMessage> Post(HttpClient client, string route, object? body = null) =>
        DebateApiFactory.SendAsync(client, HttpMethod.Post, route, body);

    private static void AssertLock(JsonElement owner, string uid, string name, string where)
    {
        Assert.True(owner.TryGetProperty("lock", out var lk) && lk.ValueKind == JsonValueKind.Object, $"{where}: sem lock");
        Assert.Equal(name, lk.GetProperty("holder").GetString());
        Assert.True(lk.TryGetProperty("holderUid", out var holderUid), $"{where}: lock sem holderUid");
        Assert.Equal(uid, holderUid.GetString());
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Lock_holder_and_author_display_name_show_admin_name_and_keep_uid()
    {
        await DebateTestDb.EnsureAsync();
        await using var db = DebateTestDb.Context();
        var live = await DebateSeed.LiveCheckAsync(db);
        await DebateSeed.AiDraftAsync(db, live.Debate, live.Check);
        var uid = $"dn-{Guid.NewGuid():N}";
        var name = $"Ana Checadora {uid[^6..]}";
        db.Profiles.Add(Profile.Create(uid, $"{uid}@example.test", name, "pt-BR", DebateSeed.Now));
        await db.SaveChangesAsync();

        await using var factory = new DebateApiFactory(DebateTestDb.Connection);
        factory.Registry.Grant(uid, "admin", "debates.review", "debates.publish");
        using var client = factory.Client(DebateApiFactory.Admin(uid));
        var route = $"/api/v1/admin/fact-checks/{live.Check.Id}";

        using (var claimed = await Post(client, $"{route}:claim")) AssertLock(await Json(claimed), uid, name, ":claim");
        using (var detail = await client.GetAsync(route)) AssertLock(await Json(detail), uid, name, "detalhe");
        using (var queue = await client.GetAsync($"/api/v1/admin/fact-checks?queue=validating&debateId={live.Debate.Id}"))
        {
            var item = (await Json(queue)).GetProperty("items").EnumerateArray()
                .Single(x => x.GetProperty("id").GetString() == live.Check.Id.ToString());
            AssertLock(item, uid, name, "fila");
        }

        using (var notValidated = await Post(client, $"{route}:not-validate", new { reasonCode = "misread", followUp = "manual_check" }))
            await Json(notValidated);
        using var after = await client.GetAsync(route);
        var actions = (await Json(after)).GetProperty("editorialActions").EnumerateArray()
            .Where(a => a.GetProperty("actorUid").GetString() == uid).ToArray();
        Assert.NotEmpty(actions);
        Assert.All(actions, a => Assert.Equal(name, a.GetProperty("authorDisplayName").GetString()));
    }
}
