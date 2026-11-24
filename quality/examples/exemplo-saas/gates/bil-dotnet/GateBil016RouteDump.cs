// Gerador de quality/config/plan-baseline-routes.json. Template do autor de gates: roda só por bil-016-baseline-routes.mjs, dentro de
// uma exportação do commit de referência, e nunca no projeto de testes do repositório. Não é gate: grava as rotas e encerra.
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace Fluxo.Api.Tests;

public sealed class GateBil016RouteDump
{
    [Fact]
    public async Task Dump_every_route_of_the_commit()
    {
        var target = Environment.GetEnvironmentVariable("BIL_016_ROUTE_DUMP");
        Assert.False(string.IsNullOrWhiteSpace(target), "BIL_016_ROUTE_DUMP é obrigatório");
        await using var factory = new DebateApiFactory();
        var routes = factory.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()
            .SelectMany(endpoint => (endpoint.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods ?? ["ANY"])
                .Select(method => $"{method} {endpoint.RoutePattern.RawText}"))
            .Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
        Assert.NotEmpty(routes);
        await File.WriteAllLinesAsync(target!, routes);
    }
}
