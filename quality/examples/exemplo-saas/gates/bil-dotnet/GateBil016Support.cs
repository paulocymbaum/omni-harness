// Apoio dos gates BIL-016. Template do autor de gates. Os tipos novos são lidos por reflexão: compila antes de RequiresPlanFeature existir.
// Rotas de BIL-013 e BIL-014 ainda não existem, por isso a marcação é exercitada em rotas de mentira, pelo pipeline real da API:
// o filtro põe o endpoint antes de UseRouting, que então não casa nada e deixa todos os middlewares do Program rodarem.
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.Extensions.DependencyInjection;

namespace Fluxo.Api.Tests;

internal static class GatePlan
{
    public const string Psp = "integracao_psp.enabled";
    public const string Marked = "/api/v1/gate-plan/marked";
    public const string Plain = "/api/v1/gate-plan/plain";
    private static readonly SemaphoreSlim MatrixGate = new(1, 1);
    private static bool matrixApplied;

    public static Type MarkerType => GateBil.Find("RequiresPlanFeature");

    public static object Marker(string key, string routeValue) => GateBil.Unwrap(() => Activator.CreateInstance(MarkerType, key, routeValue));

    public static bool IsMarked(Endpoint endpoint) => endpoint.Metadata.Any(item => item.GetType() == MarkerType);

    public static string MatrixSql()
    {
        var file = DebateTestDb.RepoFile(Path.Combine("backend", "deploy", "sql", "billing-entitlement-matrix.sql"));
        Assert.True(File.Exists(file), "backend/deploy/sql/billing-entitlement-matrix.sql ausente");
        return File.ReadAllText(file);
    }

    public static async Task ApplyMatrixAsync()
    {
        await GateBil.ApplyMvpAsync();
        var sql = MatrixSql();
        await MatrixGate.WaitAsync();
        try
        {
            if (matrixApplied) return;
            await DebateTestDb.ExecAsync(GateBil.C, sql);
            matrixApplied = true;
        }
        finally { MatrixGate.Release(); }
    }

    public static DebateApiFactory Api(string? connection = null, params (string Key, string? Value)[] extra) =>
        new(connection ?? GateBil.C, s => s.AddSingleton<IStartupFilter, GatePlanRoutes>(), GateBil.Settings(extra));

    public static Task<HttpResponseMessage> CallMarkedAsync(HttpClient client, string id, string key = Psp) =>
        client.GetAsync($"{Marked}/{Uri.EscapeDataString(key)}/{Uri.EscapeDataString(id)}");

    /// <summary>Sobrepõe o plano da empresa. Toda assinatura anterior é encerrada, para valer só a nova.</summary>
    public static async Task SetPlanAsync(string businessId, string? code, string status = "active", string rail = "pix_manual")
    {
        var customer = Guid.NewGuid();
        await DebateTestDb.ExecAsync(GateBil.C, $"""
            INSERT INTO fluxo.billing_customers(id,subject_type,subject_id,created_at,updated_at)
            VALUES ('{customer}','business','{businessId}',now(),now()) ON CONFLICT DO NOTHING;
            UPDATE fluxo.billing_subscriptions SET status='canceled', canceled_at=now()
            WHERE customer_id=(SELECT id FROM fluxo.billing_customers WHERE subject_id='{businessId}' AND subject_type='business') AND status<>'canceled';
            """);
        if (code is null) return;
        await DebateTestDb.ExecAsync(GateBil.C, $"""
            INSERT INTO fluxo.billing_subscriptions(id,customer_id,product_id,status,rail,quantity,current_period_start,current_period_end,cancel_at_period_end,created_at,updated_at,version)
            SELECT '{Guid.NewGuid()}',c.id,p.id,'{status}','{rail}',1,now(),now()+interval '30 days',false,now(),now(),0
            FROM fluxo.billing_customers c, fluxo.billing_products p
            WHERE c.subject_type='business' AND c.subject_id='{businessId}' AND p.code='{code}';
            """);
    }

    /// <summary>Forma comparável de uma rota: nome e restrição de parâmetro não contam, porque renomear {id} não torna a rota nova.</summary>
    public static string Normal(string route)
    {
        var parts = route.Trim().Split(' ', 2);
        var path = System.Text.RegularExpressions.Regex.Replace(parts[1], @"\{[^}]*\}", "{}").TrimEnd('/');
        return $"{parts[0].ToUpperInvariant()} {(path.Length == 0 ? "/" : path).ToLowerInvariant()}";
    }

    public static IEnumerable<string> Keys(RouteEndpoint endpoint) =>
        (endpoint.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods ?? ["ANY"]).Select(method => $"{method} {endpoint.RoutePattern.RawText}");

    public static string[] MarkedRoutes(IEnumerable<Endpoint> endpoints) =>
        endpoints.OfType<RouteEndpoint>().Where(IsMarked).SelectMany(Keys).Select(Normal).Distinct().Order(StringComparer.Ordinal).ToArray();

    public static JsonElement Config(string file)
    {
        var path = DebateTestDb.RepoFile(Path.Combine("quality", "config", file));
        Assert.True(File.Exists(path), $"quality/config/{file} ausente");
        return JsonDocument.Parse(File.ReadAllText(path)).RootElement.Clone();
    }

    public static string[] Routes(JsonElement config, string property) =>
        config.GetProperty(property).EnumerateArray().Select(x => Normal(x.GetString()!)).Distinct().Order(StringComparer.Ordinal).ToArray();
}

/// <summary>/gate-plan/marked/{chave}/{id} exige a chave pelo marcador; /gate-plan/plain não tem marcador e prova o caminho sem Billing.</summary>
internal sealed class GatePlanRoutes : IStartupFilter
{
    private static readonly RequestDelegate Ok = context => context.Response.WriteAsJsonAsync(new { ok = true });

    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
    {
        app.Use((context, following) =>
        {
            var path = context.Request.Path.Value ?? "";
            if (path.StartsWith(GatePlan.Plain, StringComparison.Ordinal))
                context.SetEndpoint(new Endpoint(Ok, new EndpointMetadataCollection(), "gate-plain"));
            else if (path.StartsWith(GatePlan.Marked, StringComparison.Ordinal))
            {
                var segments = path[GatePlan.Marked.Length..].Trim('/').Split('/').Select(Uri.UnescapeDataString).ToArray();
                context.Request.RouteValues["businessId"] = segments[1];
                context.SetEndpoint(new Endpoint(Ok, new EndpointMetadataCollection(GatePlan.Marker(segments[0], "businessId")), "gate-marked"));
            }
            return following();
        });
        next(app);
    };
}
