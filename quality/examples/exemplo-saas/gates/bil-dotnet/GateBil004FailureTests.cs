// Gate BIL-004-CORPO-E-FALHAS. Template do autor de gates. O processador falso implementa IBillingEventProcessor por DispatchProxy.
using System.Net;
using System.Reflection;
using System.Text;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;

namespace Fluxo.Api.Tests;

public class GateBilThrowingProxy : DispatchProxy
{
    protected override object? Invoke(MethodInfo? targetMethod, object?[]? args) =>
        throw new InvalidOperationException("psp indisponivel no gate");
}

public sealed class GateBil004FailureTests
{
    private static void UseThrowingProcessor(IServiceCollection services)
    {
        var port = GateBil.Find("IBillingEventProcessor");
        var create = typeof(DispatchProxy).GetMethods().Single(m => m.Name == "Create" && m.GetGenericArguments().Length == 2);
        var proxy = create.MakeGenericMethod(port, typeof(GateBilThrowingProxy)).Invoke(null, null)!;
        services.RemoveAll(port);
        services.AddSingleton(port, proxy);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Body_above_one_mebibyte_is_refused()
    {
        await DebateTestDb.EnsureAsync();
        await using var factory = new DebateApiFactory(GateBil.C, settings: GateBil.WebhookSettings());
        using var client = factory.CreateClient();
        using (var request = GateBil.Webhook(GateBil.WebhookPath, GateBil.EventBody($"evt_{Guid.NewGuid():N}"), GateBil.Token))
        using (var control = await client.SendAsync(request))
            Assert.Equal(HttpStatusCode.OK, control.StatusCode);
        using var large = GateBil.Webhook(GateBil.WebhookPath, "", GateBil.Token);
        large.Content = new ByteArrayContent(new byte[1_048_577]);
        using var response = await client.SendAsync(large);
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Authentic_invalid_json_is_kept_as_parse_failed_and_never_logged()
    {
        await DebateTestDb.EnsureAsync();
        var logs = new GateLogs();
        await using var factory = new DebateApiFactory(GateBil.C, s => s.AddSingleton<ILoggerProvider>(logs), GateBil.WebhookSettings());
        using var client = factory.CreateClient();
        var marker = $"corpo-cru-{Guid.NewGuid():N}";
        var body = $"nao-e-json {marker}";
        using var response = await client.SendAsync(GateBil.Webhook(GateBil.WebhookPath, body, GateBil.Token));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("parse_failed", await DebateTestDb.ScalarAsync<string>(GateBil.C, $"SELECT status FROM fluxo.billing_webhook_events WHERE raw_body LIKE '%{marker}%'"));
        Assert.DoesNotContain(marker, logs.All);
    }

    [Fact, Trait("Category", "PostgresIntegration")]
    public async Task Processor_failure_answers_200_and_keeps_the_event_pending_without_body_in_last_error()
    {
        await DebateTestDb.EnsureAsync();
        var logs = new GateLogs();
        await using var factory = new DebateApiFactory(GateBil.C, s => { UseThrowingProcessor(s); s.AddSingleton<ILoggerProvider>(logs); }, GateBil.WebhookSettings());
        using var client = factory.CreateClient();
        var id = $"evt_{Guid.NewGuid():N}";
        using var response = await client.SendAsync(GateBil.Webhook(GateBil.WebhookPath, GateBil.EventBody(id), GateBil.Token));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var where = $"FROM fluxo.billing_webhook_events WHERE provider_event_id='{id}'";
        Assert.Equal("pending", await DebateTestDb.ScalarAsync<string>(GateBil.C, $"SELECT status {where}"));
        var error = await DebateTestDb.ScalarAsync<string>(GateBil.C, $"SELECT last_error {where}");
        Assert.False(string.IsNullOrEmpty(error), "last_error deve registrar a falha do processador");
        Assert.DoesNotContain(id, error);
        Assert.DoesNotContain(GateBil.EventBody(id), logs.All);
    }

    [Fact]
    public async Task Database_down_answers_503_so_the_psp_retries()
    {
        await using var factory = new DebateApiFactory(settings: GateBil.WebhookSettings());
        using var client = factory.CreateClient();
        using var response = await client.SendAsync(GateBil.Webhook(GateBil.WebhookPath, GateBil.EventBody("evt_sem_banco"), GateBil.Token));
        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
    }
}
