// Apoio dos gates FC-017 (template do autor de gates, copiado para backend/tests/Fluxo.Api.Tests só durante o gate).
// Tipos de Homologacao são lidos por reflexão e pelo nome simples (GateFc.Find): compila antes de a implementação existir e
// o teste falha dizendo o que falta. Reaproveita GateFc (GateFcSupport.cs), GateFc2/FakeCreatorStorage (GateFc002Support.cs)
// e DebateApiFactory; só acrescenta o que é de FC-017. Nenhum uid, e-mail ou businessId real: tudo sintético (`gate-*`,
// `*@example.test`, GUID gerado na hora).
//
// FORMAS FIXADAS PELOS GATES (a spec descreve o contrato, não estas assinaturas; o implementador as segue):
//  1. Todos os tipos de Infrastructure/Homologacao são PÚBLICOS (DispatchProxy exige interface pública): HomologacaoEvaluator,
//     HomologacaoUser, HomologacaoRequirement, HomologacaoMiddleware, HomologacaoDecision (enum), IHomologacaoAccountProbe,
//     HomologacaoServiceCollectionExtensions. BusinessTeamMembershipProbe também é público (Modules/FluxoEmpresas).
//  2. `HomologacaoEvaluator.EvaluateUser(string feature, HomologacaoUser user)` devolve `HomologacaoDecision`
//     (Unrestricted, Open, ViaUser ou Denied), síncrono e puro.
//  3. `HomologacaoEvaluator.Parse(string?)` é público estático e devolve `IEnumerable<string>` sem duplicatas, preservando a
//     caixa. O marcador `none` (D7, decisão aprovada) é lista vazia.
//  4. `HomologacaoEvaluator` e `HomologacaoMiddleware` nascem da DI: o avaliador por `GetRequiredService`; o middleware por
//     ActivatorUtilities (primeiro argumento do construtor: RequestDelegate), com `InvokeAsync(HttpContext, ...)` e os demais
//     parâmetros vindos da DI.
//  5. `AddHomologacao(this IServiceCollection, IConfiguration)` exige `IHostEnvironment` na DI, registra `ValidateOnStart`
//     (resolvível por IStartupValidator) e o avaliador singleton. `RequireHomologacaoEntry(this IServiceCollection, string)`
//     é chamado por `CreatorModule.AddCreatorModule`.
//  6. O índice das mensagens de validação ("entry N") é de 1 em diante, na ordem do CSV depois do Parse.
//  7. Negar é ApiException 404; o requisito padrão usa `homologacao_not_available` e `This feature is not available.`.
//  8. Mensagens de validação e de subida nunca contêm o VALOR configurado, nem em exceção interna (isso inclui o `Mode`:
//     não deixe o binder de enum ecoar o texto inválido).
using System.Collections.Concurrent;
using System.Reflection;
using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Nodes;
using Fluxo.Api.Bootstrap;
using Fluxo.Api.Infrastructure.Legacy;
using Fluxo.Api.Infrastructure.Security;
using Fluxo.Api.Modules.Creator;
using Google.Api.Gax;
using Google.Cloud.Firestore;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Fluxo.Api.Tests;

/// <summary>Sonda falsa por DispatchProxy sobre IHomologacaoAccountProbe (lido pelo nome, então compila antes de a interface existir).</summary>
public class HomProbe : DispatchProxy
{
    public Func<string, FirebaseUser, bool> Member { get; set; } = (_, _) => false;
    public Func<string, IReadOnlyList<string>> Owners { get; set; } = _ => Array.Empty<string>();
    public Exception? MemberFails { get; set; }
    public Exception? OwnersFails { get; set; }
    public int MemberCalls;
    public int OwnerCalls;

    public int Calls => Volatile.Read(ref MemberCalls) + Volatile.Read(ref OwnerCalls);

    public static HomProbe Create()
    {
        var iface = GateFc.Find("IHomologacaoAccountProbe");
        var create = typeof(DispatchProxy).GetMethods().Single(m => m.Name == nameof(DispatchProxy.Create) && m.GetGenericArguments().Length == 2);
        return (HomProbe)create.MakeGenericMethod(iface, typeof(HomProbe)).Invoke(null, null)!;
    }

    protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
    {
        switch (targetMethod!.Name)
        {
            case "IsActiveMemberAsync":
                Interlocked.Increment(ref MemberCalls);
                return MemberFails is not null
                    ? Task.FromException<bool>(MemberFails)
                    : Task.FromResult(Member((string)args![0]!, (FirebaseUser)args[1]!));
            case "GetOwnerUidsAsync":
                Interlocked.Increment(ref OwnerCalls);
                return OwnersFails is not null
                    ? Task.FromException<IReadOnlyList<string>>(OwnersFails)
                    : Task.FromResult(Owners((string)args![0]!));
            default:
                throw new NotSupportedException($"sonda falsa: método {targetMethod.Name} não mapeado pelo gate");
        }
    }
}

/// <summary>Ambiente de hospedagem falso: o validador recebe IHostEnvironment por construtor (spec A).</summary>
internal sealed class HomEnv(string name) : IHostEnvironment
{
    public string EnvironmentName { get; set; } = name;
    public string ApplicationName { get; set; } = "fluxo-gate";
    public string ContentRootPath { get; set; } = AppContext.BaseDirectory;
    public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
}

/// <summary>RequestServices que falha se alguém resolver qualquer serviço (prova "passa direto sem resolver serviço").</summary>
internal sealed class StrictServices : IServiceProvider
{
    public int Calls;

    public object? GetService(Type serviceType)
    {
        Interlocked.Increment(ref Calls);
        throw new InvalidOperationException($"serviço resolvido sem necessidade: {serviceType.Name}");
    }
}

/// <summary>Captura em memória de tudo o que a API loga (mensagem, estado estruturado e exceção).</summary>
public sealed class HomLogs : ILoggerProvider
{
    public ConcurrentQueue<(string Category, LogLevel Level, string Text)> Entries { get; } = new();

    public ILogger CreateLogger(string categoryName) => new Sink(categoryName, this);

    public void Dispose() { }

    private sealed class Sink(string category, HomLogs owner) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            var structured = state is IEnumerable<KeyValuePair<string, object?>> pairs ? string.Join(';', pairs.Select(p => $"{p.Key}={p.Value}")) : "";
            owner.Entries.Enqueue((category, logLevel, $"{formatter(state, exception)} | {structured} | {exception}"));
        }
    }
}

/// <summary>Verificador de token de teste próprio (FC-017): claims arbitrários (email_verified, name, displayName). Tokens
/// "user:&lt;uid&gt;" continuam valendo pelo TestTokens padrão (e-mail `uid@example.test`, sem email_verified).</summary>
internal sealed class HomTokens : IFirebaseTokenVerifier
{
    public static readonly ConcurrentDictionary<string, Claim[]> Known = new();
    private readonly TestTokens inner = new();

    public Task<ClaimsPrincipal> VerifyUserTokenAsync(string token, CancellationToken cancellationToken) =>
        token.StartsWith("fc17:", StringComparison.Ordinal) && Known.TryGetValue(token, out var claims)
            ? Task.FromResult(new ClaimsPrincipal(new ClaimsIdentity(claims, "TestFirebase")))
            : inner.VerifyUserTokenAsync(token, cancellationToken);

    public Task<string> VerifyAppCheckTokenAsync(string token, CancellationToken cancellationToken) =>
        inner.VerifyAppCheckTokenAsync(token, cancellationToken);
}

public sealed record Lists(string Uids = "", string Emails = "", string Businesses = "");

public enum AppsettingsMode { None, Real, RealWithoutHomologacao }

internal sealed record HostSpec(string Environment = "Testing", AppsettingsMode Appsettings = AppsettingsMode.None, bool CreatorModule = false,
    HomProbe? Probe = null, IConfiguration? Configuration = null);

/// <summary>Contêiner mínimo com AddHomologacao (e, se pedido, AddCreatorModule). Subir com ValidateOnStart = Validate().</summary>
public sealed class HomHost : IDisposable
{
    internal HomHost(ServiceProvider services, HomProbe probe) { Services = services; Probe = probe; }

    public ServiceProvider Services { get; }
    public HomProbe Probe { get; }

    public void Dispose() => Services.Dispose();
}

internal static class GateHom
{
    public const string Open = "Open";
    public const string Allowlist = "Allowlist";
    public static readonly string[] Features = ["Creator", "Billing", "gate-feature"];

    // ───────────── reflexão ─────────────

    public static Type Find(string name) => GateFc.Find(name);

    public static object? Call(MethodInfo method, object? target, params object?[] args)
    {
        try { return method.Invoke(target, args); }
        catch (TargetInvocationException error) when (error.InnerException is not null)
        {
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error.InnerException).Throw();
            throw;
        }
    }

    private static MethodInfo Extension(string name)
    {
        var method = Find("HomologacaoServiceCollectionExtensions").GetMethod(name, BindingFlags.Public | BindingFlags.Static);
        Assert.True(method is not null, $"HomologacaoServiceCollectionExtensions sem {name} público");
        return method!;
    }

    public static string ContextItemKey() =>
        (string)typeof(FirebaseUser).GetField("ContextItemKey", BindingFlags.NonPublic | BindingFlags.Static)!.GetRawConstantValue()!;

    // ───────────── configuração e contêiner ─────────────

    public static string AppsettingsPath()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "backend", "src", "Fluxo.Api", "appsettings.json");
            if (File.Exists(candidate)) return candidate;
        }
        throw new InvalidOperationException("appsettings.json da API não encontrado");
    }

    public static Dictionary<string, string?> Entry(string feature, string key, string? value, string mode = Allowlist)
    {
        var values = new Dictionary<string, string?> { [$"Homologacao:{feature}:Mode"] = mode };
        values[$"Homologacao:{feature}:{key}"] = value;
        return values;
    }

    public static Dictionary<string, string?> Lists3(string feature, string uids = "", string emails = "", string businesses = "", string mode = Allowlist) => new()
    {
        [$"Homologacao:{feature}:Mode"] = mode,
        [$"Homologacao:{feature}:AllowedUserUids"] = uids,
        [$"Homologacao:{feature}:AllowedUserEmails"] = emails,
        [$"Homologacao:{feature}:AllowedBusinessIds"] = businesses,
    };

    public static Dictionary<string, string?> Merge(params Dictionary<string, string?>[] parts)
    {
        var all = new Dictionary<string, string?>();
        foreach (var part in parts) foreach (var (key, value) in part) all[key] = value;
        return all;
    }

    public static HomHost Host(Dictionary<string, string?> settings, HostSpec? spec = null)
    {
        spec ??= new HostSpec();
        var builder = new ConfigurationBuilder();
        IConfiguration config;
        if (spec.Configuration is not null) config = spec.Configuration;
        else
        {
            if (spec.Appsettings != AppsettingsMode.None)
            {
                var json = JsonNode.Parse(File.ReadAllText(AppsettingsPath()))!.AsObject();
                if (spec.Appsettings == AppsettingsMode.RealWithoutHomologacao) json.Remove("Homologacao");
                builder.AddJsonStream(new MemoryStream(System.Text.Encoding.UTF8.GetBytes(json.ToJsonString())));
            }
            config = builder.AddInMemoryCollection(settings).Build();
        }
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton<IHostEnvironment>(new HomEnv(spec.Environment));
        services.AddSingleton(config);
        Call(Extension("AddHomologacao"), null, services, config);
        if (spec.CreatorModule) CreatorModule.AddCreatorModule(services, config);
        var probe = spec.Probe ?? HomProbe.Create();
        services.AddSingleton(Find("IHomologacaoAccountProbe"), probe);
        var provider = services.BuildServiceProvider();
        try
        {
            provider.GetService<IStartupValidator>()?.Validate();
        }
        catch
        {
            provider.Dispose();
            throw;
        }
        return new HomHost(provider, probe);
    }

    /// <summary>A subida precisa falhar. Falha do próprio gate (tipo ausente, assert) NÃO conta como "subida rejeitada".</summary>
    public static Exception Rejects(Action startup)
    {
        try { startup(); }
        catch (Xunit.Sdk.XunitException) { throw; }
        catch (Exception error) { return error; }
        throw new Xunit.Sdk.XunitException("a subida deveria falhar e não falhou");
    }

    public static Exception RejectsHost(Dictionary<string, string?> settings, HostSpec? spec = null) => Rejects(() => Host(settings, spec).Dispose());

    // ───────────── avaliador ─────────────

    public static object Evaluator(HomHost host) => host.Services.GetRequiredService(Find("HomologacaoEvaluator"));

    public static object HomUser(string? uid, string? email = null, bool verified = false) =>
        Activator.CreateInstance(Find("HomologacaoUser"), uid, email, verified)!;

    public static string EvalUser(HomHost host, string feature, string? uid, string? email = null, bool verified = false)
    {
        var evaluator = Evaluator(host);
        var method = evaluator.GetType().GetMethod("EvaluateUser", [typeof(string), Find("HomologacaoUser")]);
        Assert.True(method is not null, "HomologacaoEvaluator sem EvaluateUser(string, HomologacaoUser)");
        return Call(method!, evaluator, feature, HomUser(uid, email, verified))!.ToString()!;
    }

    public static async Task<string> EvalAsync(HomHost host, string feature, FirebaseUser user, string? businessId)
    {
        var evaluator = Evaluator(host);
        var method = evaluator.GetType().GetMethod("EvaluateAsync");
        Assert.True(method is not null, "HomologacaoEvaluator sem EvaluateAsync");
        var task = (Task)Call(method!, evaluator, feature, user, businessId, host.Probe, CancellationToken.None)!;
        await task.ConfigureAwait(false);
        return task.GetType().GetProperty("Result")!.GetValue(task)!.ToString()!;
    }

    public static string[] Parse(string? text)
    {
        var method = Find("HomologacaoEvaluator").GetMethod("Parse", BindingFlags.Public | BindingFlags.Static);
        Assert.True(method is not null, "HomologacaoEvaluator sem Parse(string?) público estático");
        return ((System.Collections.IEnumerable)Call(method!, null, text)!).Cast<string>().ToArray();
    }

    /// <summary>FirebaseUser com o estado de verificação do e-mail (parâmetro EmailVerified, que a FC-017 acrescenta por último).</summary>
    public static FirebaseUser User(string uid, string? email = null, bool verified = false, string? name = "Pessoa Gate")
    {
        var ctor = typeof(FirebaseUser).GetConstructors().Single();
        var parameters = ctor.GetParameters();
        Assert.True(parameters.Any(p => p.Name == "EmailVerified"), "FirebaseUser sem o parâmetro EmailVerified");
        var args = new object?[parameters.Length];
        for (var i = 0; i < parameters.Length; i++)
        {
            var p = parameters[i];
            args[i] = p.Name switch
            {
                "Uid" => uid,
                "Email" => email,
                "Name" => name,
                "EmailVerified" => verified,
                _ => p.HasDefaultValue ? p.DefaultValue : null,
            };
        }
        return (FirebaseUser)ctor.Invoke(args);
    }

    // ───────────── middleware com metadado ─────────────

    public static object Requirement(string feature, string? code = null, string? detail = null, string parameter = "businessId") =>
        Activator.CreateInstance(Find("HomologacaoRequirement"), feature, code, detail, parameter)!;

    public sealed record Outcome(bool NextCalled, ApiException? Denied);

    public static async Task<Outcome> RunMiddlewareAsync(HomHost host, object? requirement, FirebaseUser? user, string? route = null, string? query = null,
        IServiceProvider? requestServices = null, string routeName = "businessId")
    {
        var type = Find("HomologacaoMiddleware");
        var called = false;
        RequestDelegate next = _ => { called = true; return Task.CompletedTask; };
        var middleware = ActivatorUtilities.CreateInstance(host.Services, type, next);
        var context = new DefaultHttpContext { RequestServices = requestServices ?? host.Services };
        if (user is not null) context.Items[ContextItemKey()] = user;
        if (route is not null) context.Request.RouteValues[routeName] = route;
        if (query is not null) context.Request.QueryString = new QueryString(query);
        context.SetEndpoint(new Endpoint(null, requirement is null ? EndpointMetadataCollection.Empty : new EndpointMetadataCollection(requirement), "gate"));
        var invoke = type.GetMethod("InvokeAsync") ?? type.GetMethod("Invoke");
        Assert.True(invoke is not null, "HomologacaoMiddleware sem InvokeAsync");
        var args = invoke!.GetParameters().Select((p, i) => i == 0 ? context : host.Services.GetRequiredService(p.ParameterType)).ToArray();
        try
        {
            await ((Task)Call(invoke, middleware, args)!).ConfigureAwait(false);
            return new Outcome(called, null);
        }
        catch (ApiException denied)
        {
            return new Outcome(called, denied);
        }
    }

    // ───────────── API completa (PostgreSQL) ─────────────

    public static Action<IServiceCollection> LegacyOnEmulator() => services =>
    {
        // Mesma ponte de GateBil.LegacyDirectoryOnEmulator (bil-dotnet/GateBilSupport.cs), copiada de propósito: runDotnetGate só
        // copia templates de fc-dotnet/ e o GateBilSupport.cs é de outro pacote de gates.
        services.RemoveAll<LegacyFirestoreDirectory>();
        services.AddSingleton(provider =>
        {
            var directory = new LegacyFirestoreDirectory(provider.GetRequiredService<IOptions<FirebaseSecurityOptions>>(), provider.GetRequiredService<IMemoryCache>());
            var field = typeof(LegacyFirestoreDirectory).GetField("_database", BindingFlags.NonPublic | BindingFlags.Instance);
            Assert.NotNull(field);
            field!.SetValue(directory, new Lazy<FirestoreDb>(EmulatorDb));
            return directory;
        });
    };

    public static FirestoreDb EmulatorDb()
    {
        Assert.False(string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("FIRESTORE_EMULATOR_HOST")), "FIRESTORE_EMULATOR_HOST é obrigatório neste gate");
        return new FirestoreDbBuilder { ProjectId = "integration-project", DatabaseId = "fluxo", EmulatorDetection = EmulatorDetection.EmulatorOnly }.Build();
    }

    /// <summary>API de teste com Homologacao:Creator no modo e nas listas dados. Limites de taxa folgados (PermitLimit só aceita 1 a 10000).</summary>
    public static DebateApiFactory Api(string mode, Lists? lists = null, Action<IServiceCollection>? services = null, bool emulator = false,
        params (string Key, string? Value)[] extra)
    {
        lists ??= new Lists();
        var (_, register) = FakeCreatorStorage.Create();
        var all = new List<(string, string?)>
        {
            ("Homologacao:Creator:Mode", mode), ("Homologacao:Creator:AllowedUserUids", lists.Uids),
            ("Homologacao:Creator:AllowedUserEmails", lists.Emails), ("Homologacao:Creator:AllowedBusinessIds", lists.Businesses),
            ("Creator:AssetBucket", "fluxo-gate-bucket"), ("RateLimiting:PermitLimit", "10000"),
            ("RateLimiting:Creator:Geo:TokensPerSecond", "1000"), ("RateLimiting:Creator:Geo:BurstTokens", "1000"), ("RateLimiting:Creator:Geo:QueueLimit", "0"),
        };
        all.AddRange(extra);
        Action<IServiceCollection> compose = s =>
        {
            register(s);
            s.RemoveAll<IFirebaseTokenVerifier>();
            s.AddSingleton<IFirebaseTokenVerifier, HomTokens>();
            if (emulator) LegacyOnEmulator()(s);
            services?.Invoke(s);
        };
        return new DebateApiFactory(GateFc.C, compose, GateFc.Settings(all.ToArray()));
    }

    /// <summary>Token de teste com claims arbitrários. verified: "true", "false" ou null (claim ausente).</summary>
    public static string Token(string uid, string? email = null, string? verified = null, string? name = null, string? displayName = null)
    {
        var claims = new List<Claim> { new("sub", uid), new("auth_time", DateTimeOffset.UtcNow.AddSeconds(-60).ToUnixTimeSeconds().ToString()) };
        if (email is not null) claims.Add(new Claim("email", email));
        if (verified is not null) claims.Add(new Claim("email_verified", verified));
        if (name is not null) claims.Add(new Claim("name", name));
        if (displayName is not null) claims.Add(new Claim("displayName", displayName));
        var key = $"fc17:{Guid.NewGuid():N}";
        HomTokens.Known[key] = claims.ToArray();
        return key;
    }

    public static string NewUid(string prefix = "gate-user") => $"{prefix}-{Guid.NewGuid():N}";

    public static string NewEmail(string prefix = "gate-mail") => $"{prefix}-{Guid.NewGuid():N}@example.test";

    public static async Task RevokeAsync(string businessId, string uid) =>
        await DebateTestDb.ExecAsync(GateFc.C, $"UPDATE fluxo.business_team_members SET status='revoked' WHERE business_id='{businessId}' AND user_uid='{uid}'");

    public static async Task SetProfileEmailAsync(string uid, string email) =>
        await DebateTestDb.ExecAsync(GateFc.C, $"UPDATE fluxo.profiles SET email='{email}' WHERE firebase_uid='{uid}'");

    public static async Task<int> StatusAsync(HttpClient client, string route) => (await GateFc.GetAsync(client, route)).Status;

    public static string Config(string businessId) => $"/api/v1/creator/config?businessId={Uri.EscapeDataString(businessId)}";

    public static string Kit(string businessId, string path = "") => GateFc2.Route(businessId, path);

    public const string Ufs = "/api/v1/creator/geo/ufs";

    public static string Geo(string businessId) => $"{Ufs}?businessId={Uri.EscapeDataString(businessId)}";

    /// <summary>404 com o código do recurso desligado, exatamente como o `creator_disabled` do Creator.</summary>
    public static void AssertDisabled404((int Status, JsonElement Body, HttpResponseMessage Raw) result, string what)
    {
        Assert.True(result.Status == 404, $"{what}: esperava 404, veio {result.Status}");
        Assert.Equal("creator_disabled", GateFc.Code(result.Body));
    }

    public static IEnumerable<RouteEndpoint> Endpoints(DebateApiFactory factory) =>
        factory.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>();

    public static object? RequirementOf(Endpoint endpoint) => endpoint.Metadata.FirstOrDefault(m => m.GetType().Name == "HomologacaoRequirement");

    public static string? FeatureOf(object requirement) => requirement.GetType().GetProperty("Feature")?.GetValue(requirement) as string;
}
