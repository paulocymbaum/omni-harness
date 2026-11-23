// Apoio dos gates BIL-*. Template do autor de gates: copiado para backend/tests/Fluxo.Api.Tests só durante o gate.
// Tipos de Billing são lidos por reflexão e pelo nome simples: este arquivo compila antes de o módulo existir, e o
// teste falha dizendo o que falta. Nada aqui chama PSP nem rede, e nenhuma credencial real é usada.
using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Fluxo.Api.Infrastructure.Legacy;
using Fluxo.Api.Infrastructure.Persistence;
using Fluxo.Api.Infrastructure.Security;
using Fluxo.Api.Modules.FluxoEmpresas;
using Google.Api.Gax;
using Google.Cloud.Firestore;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Npgsql;

namespace Fluxo.Api.Tests;

internal static class GateBil
{
    public const string WebhookPath = "/webhooks/billing/asaas";
    public const string Token = "gate-webhook-token-atual";
    public const string PreviousToken = "gate-webhook-token-anterior";
    private static readonly SemaphoreSlim MvpGate = new(1, 1);
    private static bool mvpApplied;

    public static string C => DebateTestDb.Connection;

    public static Type Find(string name)
    {
        var found = typeof(FluxoDbContext).Assembly.GetTypes().Where(t => t.Name == name).ToArray();
        Assert.True(found.Length == 1, $"tipo {name}: esperava 1 no assembly da API, encontrei {found.Length}");
        return found[0];
    }

    public static string Norm(string value) => value.Replace("_", "", StringComparison.Ordinal).ToLowerInvariant();

    public static object Unwrap(Func<object?> call)
    {
        try { return call() ?? throw new InvalidOperationException("retorno nulo"); }
        catch (TargetInvocationException error) when (error.InnerException is not null) { throw error.InnerException; }
    }

    public static Dictionary<string, string?> Settings(params (string Key, string? Value)[] extra)
    {
        var values = new Dictionary<string, string?> { ["Billing:Enabled"] = "true", ["Billing:Provider"] = "stub" };
        foreach (var (key, value) in extra) values[key] = value;
        return values;
    }

    public static Dictionary<string, string?> WebhookSettings(params (string Key, string? Value)[] extra) =>
        Settings([("Asaas:WebhookToken", Token), ("Asaas:WebhookTokenPrevious", PreviousToken), .. extra]);

    public static async Task ApplyMvpAsync()
    {
        await DebateTestDb.EnsureAsync();
        await MvpGate.WaitAsync();
        try
        {
            if (mvpApplied) return;
            await DebateTestDb.ExecAsync(C, DebateTestDb.Sql("billing-mvp.sql"));
            mvpApplied = true;
        }
        finally { MvpGate.Release(); }
    }

    public static async Task<(string Id, string OwnerUid)> SeedBusinessAsync()
    {
        await DebateTestDb.EnsureAsync();
        var key = Guid.NewGuid().ToString("N");
        var (profile, id, owner) = (Guid.NewGuid(), $"gate-{key}", $"owner-{key}");
        await DebateTestDb.ExecAsync(C, $"""
            INSERT INTO fluxo.profiles(id,firebase_uid,display_name,locale,created_at,updated_at)
            VALUES ('{profile}','{owner}','Dona Gate','pt-BR',now(),now());
            INSERT INTO fluxo.businesses(id,owner_profile_id,slug,display_name,status,created_at,updated_at)
            VALUES ('{id}','{profile}','{id}','Empresa Gate','Active',now(),now());
            """);
        return (id, owner);
    }

    public static async Task<string> SeedMemberAsync(string businessId, string role)
    {
        var uid = $"{role.ToLowerInvariant()}-{Guid.NewGuid():N}";
        await using var db = DebateTestDb.Context();
        db.BusinessTeamMembers.Add(BusinessTeamMember.Create(businessId, uid, role, BusinessTeamPolicy.PermissionsFor(role),
            "active", DateTimeOffset.UtcNow));
        await db.SaveChangesAsync();
        return uid;
    }

    public static async Task<List<string>> RowsAsync(string connection, string sql)
    {
        await using var conn = new NpgsqlConnection(connection);
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(sql, conn);
        await using var reader = await cmd.ExecuteReaderAsync();
        var rows = new List<string>();
        while (await reader.ReadAsync()) rows.Add(reader.IsDBNull(0) ? "" : Convert.ToString(reader.GetValue(0))!);
        return rows;
    }

    public static IEnumerable<string> Strings(JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.String: yield return element.GetString()!; break;
            case JsonValueKind.Array:
                foreach (var item in element.EnumerateArray())
                    foreach (var text in Strings(item)) yield return text;
                break;
            case JsonValueKind.Object:
                foreach (var property in element.EnumerateObject())
                    foreach (var text in Strings(property.Value)) yield return text;
                break;
        }
    }

    public static async Task<JsonElement> JsonAsync(HttpResponseMessage response)
    {
        var text = await response.Content.ReadAsStringAsync();
        Assert.True(response.IsSuccessStatusCode, $"HTTP {(int)response.StatusCode}: {text}");
        return JsonDocument.Parse(text).RootElement.Clone();
    }

    public static HttpRequestMessage Webhook(string path, string body, string? token, string? forwardedFor = null)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        if (token is not null) request.Headers.TryAddWithoutValidation("asaas-access-token", token);
        if (forwardedFor is not null) request.Headers.TryAddWithoutValidation("X-Forwarded-For", forwardedFor);
        return request;
    }

    public static string EventBody(string id) => "{\"id\":\"" + id + "\",\"event\":\"PAYMENT_RECEIVED\",\"payment\":{\"id\":\"pay_gate\"}}";

    public static Task<long> WebhookRowsAsync(string providerEventId) => DebateTestDb.ScalarAsync<long>(C,
        $"SELECT count(*) FROM fluxo.billing_webhook_events WHERE provider_event_id = '{providerEventId}'");

    /// <summary>
    /// LegacyFirestoreDirectory não usa EmulatorDetection e é selada: sem esta troca, o fallback iria ao Firestore real.
    /// O gate aponta o campo privado para o emulador, sem mudar produção.
    /// </summary>
    public static Action<IServiceCollection> LegacyDirectoryOnEmulator() => services =>
    {
        services.RemoveAll<LegacyFirestoreDirectory>();
        services.AddSingleton(provider =>
        {
            var directory = new LegacyFirestoreDirectory(provider.GetRequiredService<IOptions<FirebaseSecurityOptions>>(),
                provider.GetRequiredService<IMemoryCache>());
            var field = typeof(LegacyFirestoreDirectory).GetField("_database", BindingFlags.NonPublic | BindingFlags.Instance);
            Assert.NotNull(field);
            field!.SetValue(directory, new Lazy<FirestoreDb>(EmulatorDb));
            return directory;
        });
    };

    public static FirestoreDb EmulatorDb()
    {
        Assert.False(string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("FIRESTORE_EMULATOR_HOST")),
            "FIRESTORE_EMULATOR_HOST é obrigatório neste gate");
        return new FirestoreDbBuilder { ProjectId = "integration-project", DatabaseId = "fluxo", EmulatorDetection = EmulatorDetection.EmulatorOnly }.Build();
    }
}

/// <summary>Sobe a API em Production, com Firebase completo, para provar as travas de subida.</summary>
internal sealed class GateProductionFactory(IReadOnlyDictionary<string, string?> settings) : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        var values = new Dictionary<string, string?>(settings)
        {
            ["ConnectionStrings:Postgres"] = "Host=127.0.0.1;Database=unused;Username=unused;Password=unused;SSL Mode=Require",
            ["Firebase:ProjectId"] = "production-project",
            ["Firebase:ProjectNumber"] = "123456789",
            ["Firebase:RequireAppCheck"] = "true",
        };
        builder.UseEnvironment("Production");
        foreach (var (key, value) in values) builder.UseSetting(key, value);
        builder.ConfigureAppConfiguration((_, configuration) => configuration.AddInMemoryCollection(values));
    }
}

/// <summary>Captura todo log da API, para provar que corpo cru e documento nunca são gravados.</summary>
internal sealed class GateLogs : ILoggerProvider, ILogger
{
    private readonly ConcurrentQueue<string> lines = new();
    public string All => string.Join('\n', lines);
    public ILogger CreateLogger(string categoryName) => this;
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel logLevel) => true;
    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
        lines.Enqueue($"{formatter(state, exception)} {exception}");
    public void Dispose() { }
}

internal static class GateCrypto
{
    public static readonly byte[] OldKey = RandomNumberGenerator.GetBytes(32);
    public static readonly byte[] NewKey = RandomNumberGenerator.GetBytes(32);
    public static readonly byte[] HmacKey = RandomNumberGenerator.GetBytes(32);

    public static string Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public static byte[] FromUrl(string text)
    {
        var padded = text.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(padded.PadRight(padded.Length + ((4 - (padded.Length % 4)) % 4), '='));
    }

    public static (string Key, string? Value)[] Keys(string active = "k1", bool withNew = false) =>
    [
        ("ApplicationCrypto:ActiveKeyId", active),
        ("ApplicationCrypto:Keys:k1", Url(OldKey)),
        ("ApplicationCrypto:HmacKey", Url(HmacKey)),
        .. withNew ? new (string, string?)[] { ("ApplicationCrypto:Keys:k2", Url(NewKey)) } : [],
    ];
}

internal sealed class GateProtector(object inner)
{
    private static Type Port => GateBil.Find("ISensitiveDataProtector");
    private string Call(string name, params object[] args) => (string)GateBil.Unwrap(() => Port.GetMethod(name)!.Invoke(inner, args));
    public string Protect(string text, string aad) => Call(nameof(Protect), text, aad);
    public string Unprotect(string envelope, string aad) => Call(nameof(Unprotect), envelope, aad);
    public string Blind(string value, string context) => Call(nameof(Blind), value, context);
    public static GateProtector From(DebateApiFactory factory) => new(factory.Services.GetRequiredService(Port));
}
