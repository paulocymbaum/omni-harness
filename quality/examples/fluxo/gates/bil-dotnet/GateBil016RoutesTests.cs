// Gate BIL-016-SO-RECURSO-NOVO. Template do autor de gates. A garantia que o gate BIL-002-ENTITLEMENT-SEM-CORTE não dá: a marcação nunca
// chega a rota que já existia no commit a3f4b116. A base em quality/config/plan-baseline-routes.json é conferida por hash no .mjs.
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.Extensions.DependencyInjection;

namespace Fluxo.Api.Tests;

public sealed class GateBil016RoutesTests
{
    private static EndpointDataSource Source(DebateApiFactory factory) => factory.Services.GetRequiredService<EndpointDataSource>();

    [Fact]
    public async Task Marked_routes_are_exactly_the_manifest()
    {
        await using var factory = new DebateApiFactory(settings: GateBil.Settings());
        var type = GatePlan.MarkerType;
        Assert.Equal("Fluxo.Api.Infrastructure.Security", type.Namespace);
        Assert.Equal(GatePlan.Routes(GatePlan.Config("plan-gated-routes.json"), "routes"), GatePlan.MarkedRoutes(Source(factory).Endpoints));
    }

    [Fact]
    public async Task No_marked_or_planned_route_existed_at_the_reference_commit()
    {
        await using var factory = new DebateApiFactory(settings: GateBil.Settings());
        var baseline = GatePlan.Routes(GatePlan.Config("plan-baseline-routes.json"), "routes");
        var manifest = GatePlan.Config("plan-gated-routes.json");
        var current = Source(factory).Endpoints.OfType<RouteEndpoint>().SelectMany(GatePlan.Keys).Select(GatePlan.Normal).ToHashSet();
        // Sem isto, um formato de chave errado esvaziaria a interseção: as duas listas precisam falar a mesma língua.
        Assert.Contains("GET /api/v1/businesses/{}", baseline);
        Assert.True(current.Overlaps(baseline), "base e rotas atuais não são comparáveis");
        Assert.Empty(GatePlan.MarkedRoutes(Source(factory).Endpoints).Intersect(baseline));
        Assert.Empty(GatePlan.Routes(manifest, "routes").Intersect(baseline));
        Assert.Empty(GatePlan.Routes(manifest, "planned").Intersect(baseline));
    }

    [Fact]
    public void A_route_of_the_baseline_with_the_marker_is_caught()
    {
        var baseline = GatePlan.Routes(GatePlan.Config("plan-baseline-routes.json"), "routes");
        // Renomear o parâmetro e mudar a caixa não escapa da comparação.
        var pattern = RoutePatternFactory.Parse("/api/v1/Businesses/{renamed}/activate");
        var marked = new RouteEndpoint(_ => Task.CompletedTask, pattern, 0,
            new EndpointMetadataCollection(new HttpMethodMetadata(["POST"]), GatePlan.Marker(GatePlan.Psp, "renamed")), "gate");
        Assert.Equal(["POST /api/v1/businesses/{}/activate"], GatePlan.MarkedRoutes([marked]).Intersect(baseline));
    }

    [Fact]
    public async Task Planned_routes_are_the_two_of_the_spec_and_carry_the_marker_once_they_exist()
    {
        await using var factory = new DebateApiFactory(settings: GateBil.Settings());
        var manifest = GatePlan.Config("plan-gated-routes.json");
        string[] spec = ["POST /api/v1/businesses/{}/mercado-pago/connect/start", "POST /api/v1/internal/merchant-pix/businesses/{}/orders"];
        var known = GatePlan.Routes(manifest, "routes").Concat(GatePlan.Routes(manifest, "planned")).ToArray();
        Assert.Empty(spec.Except(known));
        var current = Source(factory).Endpoints.OfType<RouteEndpoint>().SelectMany(GatePlan.Keys).Select(GatePlan.Normal);
        Assert.Empty(GatePlan.Routes(manifest, "planned").Intersect(current));
    }
}
