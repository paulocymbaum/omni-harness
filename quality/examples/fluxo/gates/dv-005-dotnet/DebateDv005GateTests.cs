// Gate DV-005 (pendências herdadas da DV-004): persistência aditiva e motivos de descarte alinhados.
// Template do autor de gates: copiado para backend/tests/Fluxo.Api.Tests só durante o gate e removido depois.
// Lê as colunas por to_jsonb(linha) para não depender de nomes de propriedades C#.
using System.Net;
using System.Text.Json;
using Fluxo.Api.Modules.Debates;
using Npgsql;

namespace Fluxo.Api.Tests;

public sealed class DebateDv005GateTests
{
    private static readonly string[] DiscardReasons =
        ["not_checkable", "opinion", "vague_promise", "attack_without_fact", "extraction_error", "duplicate", "other"];

    private static async Task<JsonElement> RowAsync(string table, Guid id)
    {
        await using var conn = new NpgsqlConnection(DebateTestDb.Connection);
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand($"SELECT to_jsonb(t)::text FROM fluxo.{table} t WHERE id = @id", conn);
        cmd.Parameters.AddWithValue("id", id);
        var text = (string?)await cmd.ExecuteScalarAsync() ?? throw new InvalidOperationException($"{table} {id} ausente");
        return JsonDocument.Parse(text).RootElement.Clone();
    }

    private static async Task<string> ScalarAsync(string sql)
    {
        await using var conn = new NpgsqlConnection(DebateTestDb.Connection);
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(sql, conn);
        return Convert.ToString(await cmd.ExecuteScalarAsync()) ?? "";
    }

    private static string? Str(JsonElement row, params string[] names)
    {
        foreach (var n in names)
            if (row.TryGetProperty(n, out var v) && v.ValueKind != JsonValueKind.Null) return v.ToString();
        return null;
    }

    private static async Task<(DebateApiFactory Factory, Debate Debate, DebateParticipant Participant, HttpClient Worker, HttpClient Admin)>
        LiveAsync()
    {
        await DebateTestDb.EnsureAsync();
        var factory = new DebateApiFactory(DebateTestDb.Connection);
        await using var db = DebateTestDb.Context();
        var debate = DebateSeed.NewDebate(DebateStatus.Live, false);
        db.Debates.Add(debate);
        var participant = DebateParticipant.Create(debate.Id, ParticipantRole.Candidate, 1, "Candidata A", "PFX", 10, DebateSeed.Now);
        var other = DebateParticipant.Create(debate.Id, ParticipantRole.Candidate, 2, "Candidato B", "PFY", 20, DebateSeed.Now);
        db.DebateParticipants.AddRange(participant, other);
        await db.SaveChangesAsync();
        var uid = $"op-{Guid.NewGuid():N}";
        factory.Registry.Grant(uid, "admin", "debates.manage", "debates.operate", "debates.review", "debates.publish");
        return (factory, debate, participant, factory.Client(WorkerTokens.Create()), factory.Client(DebateApiFactory.Admin(uid)));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Ai_run_persists_provider_region_cache_creation_invalid_items_and_subject()
    {
        var (factory, debate, _, worker, _) = await LiveAsync();
        await using var _f = factory;
        var subject = Guid.NewGuid();
        using var response = await DebateApiFactory.SendAsync(worker, HttpMethod.Post, $"/api/v1/internal/debates/{debate.Id}/ai-runs", new
        {
            kind = "extraction", provider = "vertex-anthropic", model = "claude-haiku-5-5", region = "global", promptVersion = "extract-v1",
            inputSha256 = new string('a', 64), inputTokens = 120, outputTokens = 45, cacheCreationInputTokens = 80, cacheReadInputTokens = 64,
            latencyMs = 15, status = "ok", invalidItems = 2, numberMismatches = 1, subjectType = "utterance", subjectId = subject
        });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var id = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.GetProperty("aiRunId").GetGuid();
        var row = await RowAsync("debate_ai_runs", id);
        Assert.Equal("vertex-anthropic", Str(row, "provider"));
        Assert.Equal("global", Str(row, "region"));
        Assert.Equal("80", Str(row, "cache_creation_input_tokens"));
        Assert.Equal("64", Str(row, "cached_input_tokens", "cache_read_input_tokens"));
        Assert.Equal("2", Str(row, "invalid_items"));
        Assert.Equal("utterance", Str(row, "subject_type"));
        Assert.Equal(subject.ToString(), Str(row, "subject_id"));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Ai_run_accepts_check_kinds_including_factcheck_lookup()
    {
        var (factory, debate, _, worker, _) = await LiveAsync();
        await using var _f = factory;
        foreach (var kind in new[] { "factcheck_lookup", "search", "verdict", "embedding" })
        {
            using var response = await DebateApiFactory.SendAsync(worker, HttpMethod.Post, $"/api/v1/internal/debates/{debate.Id}/ai-runs", new
            {
                kind, provider = kind == "factcheck_lookup" ? "google-factcheck" : "vertex", model = kind == "factcheck_lookup" ? "claims:search" : "m",
                region = "global", inputTokens = 0, outputTokens = 0, latencyMs = 5, status = "ok",
                subjectType = "fact_check", subjectId = Guid.NewGuid()
            });
            Assert.True(response.StatusCode == HttpStatusCode.Created, $"{kind}: {(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");
        }
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Extraction_persists_priority_discard_reason_and_question_topic()
    {
        var (factory, debate, participant, worker, admin) = await LiveAsync();
        await using var _f = factory;
        const string text = "O desemprego caiu para 5,3%. Vou cuidar de tudo. A obra custou caro.";
        using (var utt = await DebateApiFactory.SendAsync(worker, HttpMethod.Post, $"/api/v1/internal/debates/{debate.Id}/utterances", new
               {
                   ingestionId = Guid.NewGuid(), sessionNo = 1, seq = 1, asrProvider = "soniox", asrModel = "stt-rt-v3", speakerLabel = "spk_1",
                   captureStartedAt = DateTimeOffset.UtcNow.AddMinutes(-5), startMs = 1000, endMs = 4000, text, confidence = 0.9, origin = "live"
               }))
            Assert.Equal(HttpStatusCode.Created, utt.StatusCode);
        using (var confirm = await DebateApiFactory.SendAsync(admin, HttpMethod.Put, $"/api/v1/admin/debates/{debate.Id}/speakers/spk_1",
                   new { participantId = participant.Id }))
            Assert.Equal(HttpStatusCode.OK, confirm.StatusCode);
        using var leaseResponse = await DebateApiFactory.SendAsync(worker, HttpMethod.Post, $"/api/v1/internal/debates/{debate.Id}/work:lease",
            new { workerId = "gate", kinds = new[] { "extract" }, max = 5 });
        var lease = JsonDocument.Parse(await leaseResponse.Content.ReadAsStringAsync()).RootElement;
        var leaseId = lease.GetProperty("leaseId").GetGuid();
        var utteranceId = lease.GetProperty("items")[0].GetProperty("itemId").GetGuid();
        await using var db = DebateTestDb.Context();
        var addressee = db.DebateParticipants.Single(x => x.DebateId == debate.Id && x.Id != participant.Id).Id;

        using var ok = await DebateApiFactory.SendAsync(worker, HttpMethod.Post, $"/api/v1/internal/debates/{debate.Id}/extractions", new
        {
            leaseId, utteranceId, promptVersion = "extract-v1",
            claims = new object[]
            {
                new { quote = "O desemprego caiu para 5,3%", quoteStart = 0, quoteEnd = 27, normalized = "Desemprego caiu para 5,3%.",
                    type = "number", topic = "emprego", priority = 1, checkable = true, discardReason = (string?)null },
                new { quote = "Vou cuidar de tudo", quoteStart = 29, quoteEnd = 47, normalized = "Vai cuidar de tudo.",
                    type = "promise", topic = "gestão", priority = 3, checkable = false, discardReason = (string?)"vague_promise" },
                new { quote = "A obra custou caro", quoteStart = 49, quoteEnd = 67, normalized = "A obra custou caro.",
                    type = "other", topic = "obras", priority = 2, checkable = false, discardReason = (string?)"not_checkable" }
            },
            question = new { addresseeParticipantId = addressee, topic = "saúde", text = "O que fará pela saúde?" }
        });
        Assert.True(ok.StatusCode == HttpStatusCode.Created, await ok.Content.ReadAsStringAsync());
        var body = JsonDocument.Parse(await ok.Content.ReadAsStringAsync()).RootElement;
        var claimIds = body.GetProperty("claims").EnumerateArray().Select(c => c.GetProperty("id").GetGuid()).ToArray();
        var rows = new List<JsonElement>();
        foreach (var id in claimIds) rows.Add(await RowAsync("debate_claims", id));
        Assert.Equal("1|3|2", string.Join('|', rows.Select(r => Str(r, "priority") ?? "(null)")));
        var reasons = rows.Select(r => Str(r, "discard_reason", "discard_reason_code", "discarded_reason_code") ?? "(null)");
        Assert.Equal("(null)|vague_promise|not_checkable", string.Join('|', reasons));
        var question = await RowAsync("debate_questions", body.GetProperty("questionIds")[0].GetGuid());
        Assert.Equal("saúde", Str(question, "topic"));
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Discard_reason_code_wire_and_sql_check_are_aligned()
    {
        await DebateTestDb.EnsureAsync();
        Assert.Equal(DiscardReasons.Order(), DebateWire.Values<DiscardReasonCode>().Order());
        var def = await ScalarAsync("""
            SELECT string_agg(pg_get_constraintdef(c.oid), ' ') FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = 'fluxo' AND t.relname = 'debate_claims' AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%opinion%'
            """);
        foreach (var reason in DiscardReasons) Assert.Contains($"'{reason}'", def);
    }
}
