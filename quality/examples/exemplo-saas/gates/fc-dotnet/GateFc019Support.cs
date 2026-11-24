// Apoio dos gates FC-019 (template do autor de gates, copiado para backend/tests/Fluxo.Api.Tests só durante o gate).
// Tipos novos de Infrastructure/Security (DevAuthOverrideOptions, DevOverrideTokenVerifier) são lidos por reflexão e
// pelo nome simples (GateFc.Find): compila antes de a implementação existir e o teste falha dizendo o que falta.
// Reaproveita GateFc (GateFcSupport.cs), GateFc2/FakeCreatorStorage (GateFc002Support.cs), HomEnv/HomLogs/GateHom
// (GateFc017Support.cs). Nenhum uid, e-mail ou businessId real: tudo sintético (`gate-*`, `*@example.test`).
//
// Diferença central para DebateApiFactory: DevApiFactory NÃO remove IFirebaseTokenVerifier — o registro real de
// AddFirebaseSecurity (verificador concreto + decorador quando Enabled) fica de pé e é ele que as requisições
// exercitam. Firebase:ProjectId é `fluxo-local` para casar com o seed do emulador (seed-firestore.mjs).
//
// FORMAS FIXADAS PELOS GATES (a spec FC-019 descreve o contrato, não estas assinaturas; o implementador as segue):
//  1. `AddFirebaseSecurity(this IServiceCollection, IConfiguration)` é público estático em
//     FirebaseSecurityServiceCollectionExtensions e valida Auth:DevOverride na subida (ValidateOnStart).
//  2. Com Auth:DevOverride:Enabled=false (padrão do appsettings.json), o container resolve IFirebaseTokenVerifier
//     como o FirebaseTokenVerifier concreto (o decorador nem é instanciado).
//  3. Com Enabled=true (só Development/Testing, uid na lista, FIRESTORE_EMULATOR_HOST presente), o container
//     resolve o decorador; `Bearer dev.<uid>` vale como o usuário `<uid>` com e-mail `<uid>@example.test`,
//     email_verified=false e auth_time corrente; NENHUM claim de privilégio (fluxoAdmin, adminRole, tenant,
//     sign_in_second_factor, permissionsVersion, firebase) e nenhum `name`.
//  4. O decorador reavalia ambiente/Enabled/uid A CADA requisição: mutar o ambiente derruba o token já aceito.
//  5. `FirebaseUser.From(principal, appId)` deriva IsFluxoAdmin=false e demais nulos; admin segue 403 admin_required.
//  6. Mensagens de validação citam a CHAVE (Auth:DevOverride:...), nunca o valor configurado.
using System.Net.Http.Headers;
using System.Reflection;
using Fluxo.Api.Infrastructure.Legacy;
using Fluxo.Api.Infrastructure.Security;
using Google.Api.Gax;
using Google.Cloud.Firestore;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;

namespace Fluxo.Api.Tests;

/// <summary>API completa SEM remover IFirebaseTokenVerifier: a borda real (com o decorador quando Enabled) é exercitada.</summary>
internal sealed class DevApiFactory(string? connection = null, Action<IServiceCollection>? services = null,
    IDictionary<string, string?>? settings = null) : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        var values = new Dictionary<string, string?>
        {
            ["ConnectionStrings:Postgres"] = connection ?? "Host=127.0.0.1;Port=1;Database=unused;Username=unused;Password=unused",
            ["Firebase:ProjectId"] = "fluxo-local",
            ["Firebase:ProjectNumber"] = "123456789",
            ["Firebase:RequireAppCheck"] = "false",
            ["DebateWorker:ServiceAccountEmail"] = "gate-worker@example.test",
            ["DebateWorker:Audiences:0"] = DebateApiFactory.Audience,
            ["Debates:AudioBucket"] = "fluxo-ath-debates-audio",
            ["Debates:ApiServiceAccountEmail"] = "gate-api@example.test",
        };
        foreach (var (key, value) in settings ?? new Dictionary<string, string?>()) values[key] = value;
        builder.UseEnvironment("Testing");
        foreach (var (key, value) in values) builder.UseSetting(key, value);
        builder.ConfigureAppConfiguration((_, configuration) => configuration.AddInMemoryCollection(values));
        builder.ConfigureTestServices(s =>
        {
            // Propósito: SEM RemoveAll<IFirebaseTokenVerifier> e SEM IAdminAccessRegistry falso.
            s.RemoveAll<IOidcSigningKeyProvider>();
            s.AddSingleton<IOidcSigningKeyProvider>(new StaticKeys(WorkerTokens.Key));
            services?.Invoke(s);
        });
    }

    public HttpClient Client(string token)
    {
        var client = CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return client;
    }
}

/// <summary>Host mínimo com AddFirebaseSecurity (por reflexão): provaca o IStartupValidator sem subir HTTP.</summary>
internal sealed class DevHost(HomEnv env, ServiceProvider services) : IDisposable
{
    public HomEnv Env { get; } = env;
    public ServiceProvider Services { get; } = services;
    public IFirebaseTokenVerifier Verifier => Services.GetRequiredService<IFirebaseTokenVerifier>();
    public string VerifierTypeName => Verifier.GetType().Name;
    public void Dispose() => Services.Dispose();
}

internal static class GateDev
{
    public const string DevPrefix = "dev.";
    public static string Dev(string uid) => $"{DevPrefix}{uid}";
    public static string NewUid(string prefix = "gate-user") => $"{prefix}-{Guid.NewGuid():N}";
    public static string NewBiz() => $"gate-biz-{Guid.NewGuid():N}";

    public static string Config(string businessId) => $"/api/v1/creator/config?businessId={Uri.EscapeDataString(businessId)}";
    public const string Ufs = "/api/v1/creator/geo/ufs";
    public static string Geo(string businessId) => $"{Ufs}?businessId={Uri.EscapeDataString(businessId)}";
    public static string Kit(string businessId, string path = "") => GateFc2.Route(businessId, path);

    public static string AdminCompanies => "/api/v1/admin/companies/";
    public static string AdminGrant(string kind, string entityId, string uid) =>
        $"/api/v1/admin/event-organizer-grants/{kind}/{Uri.EscapeDataString(entityId)}/{Uri.EscapeDataString(uid)}";

    /// <summary>Settings do override: Creator ligado, homologação por lista de uid (padrão: a mesma) e rate limits folgados.</summary>
    public static Dictionary<string, string?> DevSettings(bool enabled, string uids, string? homologacaoUids = null,
        string mode = "Allowlist", params (string Key, string? Value)[] extra)
    {
        var all = new Dictionary<string, string?>
        {
            ["Firebase:ProjectId"] = "fluxo-local",
            ["Firebase:ProjectNumber"] = "123456789",
            ["Firebase:RequireAppCheck"] = "false",
            ["Creator:Enabled"] = "true",
            ["Homologacao:Creator:Mode"] = mode,
            ["Homologacao:Creator:AllowedUserUids"] = homologacaoUids ?? uids,
            ["Homologacao:Creator:AllowedUserEmails"] = "",
            ["Homologacao:Creator:AllowedBusinessIds"] = "",
            ["Auth:DevOverride:Enabled"] = enabled ? "true" : "false",
            ["Auth:DevOverride:AllowedUids"] = uids,
            ["RateLimiting:PermitLimit"] = "10000",
            ["RateLimiting:Creator:Geo:TokensPerSecond"] = "1000",
            ["RateLimiting:Creator:Geo:BurstTokens"] = "1000",
            ["RateLimiting:Creator:Geo:QueueLimit"] = "0",
        };
        foreach (var (key, value) in extra) all[key] = value;
        return all;
    }
    // ───────────── host mínimo (opções e verificador, sem HTTP) ─────────────

    public static DevHost Host(Dictionary<string, string?> settings, string environmentName = "Testing")
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(settings).Build();
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton<TimeProvider>(TimeProvider.System);
        var env = new HomEnv(environmentName);
        services.AddSingleton<IHostEnvironment>(env);
        services.AddSingleton<IConfiguration>(config);
        var type = GateFc.Find("FirebaseSecurityServiceCollectionExtensions");
        var method = type.GetMethod("AddFirebaseSecurity", BindingFlags.Public | BindingFlags.Static);
        Assert.True(method is not null, "FirebaseSecurityServiceCollectionExtensions sem AddFirebaseSecurity público");
        GateHom.Call(method, null, services, config);
        var provider = services.BuildServiceProvider();
        try { provider.GetService<IStartupValidator>()?.Validate(); }
        catch { provider.Dispose(); throw; }
        return new DevHost(env, provider);
    }

    /// <summary>A subida precisa falhar. Falha do próprio gate (tipo ausente, assert) NÃO conta como "subida rejeitada".</summary>
    public static Exception RejectsHost(Dictionary<string, string?> settings, string environmentName = "Testing") =>
        GateHom.Rejects(() => Host(settings, environmentName).Dispose());

    public static (bool Enabled, string AllowedUids) ReadOptions(DevHost host)
    {
        var type = GateFc.Find("DevAuthOverrideOptions");
        var boxed = host.Services.GetRequiredService(typeof(IOptions<>).MakeGenericType(type));
        var value = boxed!.GetType().GetProperty("Value")!.GetValue(boxed)!;
        return ((bool)value.GetType().GetProperty("Enabled")!.GetValue(value)!,
            (string)value.GetType().GetProperty("AllowedUids")!.GetValue(value)!);
    }

    public static string[] Parse(string text)
    {
        var type = GateFc.Find("DevAuthOverrideOptions");
        var method = type.GetMethod("Parse", BindingFlags.Public | BindingFlags.Static, [typeof(string)]);
        Assert.True(method is not null, "DevAuthOverrideOptions sem Parse(string) público");
        return ((IEnumerable<string>)method!.Invoke(null, [text])!).ToArray();
    }

    public static bool IsValidUid(string uid)
    {
        var type = GateFc.Find("DevAuthOverrideOptions");
        var method = type.GetMethod("IsValidUid", BindingFlags.Public | BindingFlags.Static, [typeof(string)]);
        Assert.True(method is not null, "DevAuthOverrideOptions sem IsValidUid(string) público");
        return (bool)method!.Invoke(null, [uid])!;
    }

    // ───────────── emulador do Firestore (projeto fluxo-local, igual ao seed) ─────────────

    public static FirestoreDb EmulatorDb()
    {
        Assert.False(string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("FIRESTORE_EMULATOR_HOST")),
            "FIRESTORE_EMULATOR_HOST é obrigatório neste gate");
        return new FirestoreDbBuilder { ProjectId = "fluxo-local", DatabaseId = "fluxo", EmulatorDetection = EmulatorDetection.EmulatorOnly }.Build();
    }

    /// <summary>Mesma ponte de GateHom.LegacyOnEmulator, com ProjectId `fluxo-local` para casar com o seed do gate.</summary>
    public static Action<IServiceCollection> LegacyOnEmulator() => services =>
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

    /// <summary>Semeia admin_access/&lt;uid&gt; no emulador: mesmo com grant ativo, o token dev não tem claims e segue 403.</summary>
    public static async Task SeedAdminGrantAsync(string uid)
    {
        var db = EmulatorDb();
        await db.Collection("admin_access").Document(uid).SetAsync(new Dictionary<string, object>
        {
            ["role"] = "admin",
            ["status"] = "active",
            ["permissions"] = new[] { "companies.verify", "events.moderate" },
            ["grantedAt"] = Timestamp.GetCurrentTimestamp(),
        });
    }

    // ───────────── API completa ─────────────

    /// <summary>API com o registro real do verificador. emulator: legado do Firestore no emulador (conta só lá).</summary>
    public static DevApiFactory Api(Dictionary<string, string?> settings, Action<IServiceCollection>? services = null, bool emulator = false)
    {
        Action<IServiceCollection> compose = s =>
        {
            var (_, register) = FakeCreatorStorage.Create();
            register(s);
            if (emulator) LegacyOnEmulator()(s);
            services?.Invoke(s);
        };
        return new DevApiFactory(GateFc.C, compose, settings);
    }
}
