// Apoio dos gates BIL-007 e BIL-009. Template do autor de gates. PSP de mentira em memória e HTTP falso: nada sai para a rede.
// O PSP é um DispatchProxy, não uma classe: se a tarefa acrescentar método à porta (para reler o QR, por exemplo), o template
// continua compilando, e o método novo é atendido pelo tipo de retorno. GatewayCharge também é montado por reflexão.
using System.Collections.Concurrent;
using System.Net;
using System.Reflection;
using System.Text;
using System.Text.Json;
using Fluxo.Api.Infrastructure.Persistence;
using Fluxo.Api.Modules.Billing.Domain;
using Fluxo.Api.Modules.Billing.Gateways;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Npgsql;

namespace Fluxo.Api.Tests;

// Sem paralelismo: o job percorre a tabela inteira e usa advisory lock, então duas classes juntas interfeririam entre si.
[CollectionDefinition("GateBilSerial", DisableParallelization = true)]
public sealed class GateBilSerialCollection;

internal sealed class GatePsp
{
    public ConcurrentDictionary<string, GatewayCharge> Charges { get; } = new();
    public ConcurrentQueue<string> Violations { get; } = new();
    public int Customers, Creates, Gets, Refunds, Finds, Touches;
    public bool Down, FailAfterCreate, Forbidden;
    public TimeSpan CreateDelay, RefundDelay;
    /// <summary>Application Name das conexões da API: liga a sonda de pg_stat_activity. Nulo em teste concorrente.</summary>
    public string? ProbeApplication;

    public static GatewayCharge Charge(string id, string reference, string customer, long cents, string currency, BillingChargeStatus status, DateTimeOffset? paidAt)
    {
        var ctor = typeof(GatewayCharge).GetConstructors().OrderByDescending(c => c.GetParameters().Length).First();
        var values = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase)
        {
            ["ExternalChargeId"] = id, ["ExternalReference"] = reference, ["ExternalCustomerId"] = customer, ["AmountCents"] = cents,
            ["Currency"] = currency, ["Status"] = status, ["PaidAt"] = paidAt, ["BrCode"] = $"br-{id}", ["QrImageDataUri"] = "data:image/png;base64,R0FURQ==",
            ["ExpiresAt"] = DateTimeOffset.UtcNow.AddHours(1),
        };
        return (GatewayCharge)ctor.Invoke(ctor.GetParameters().Select(p => values.GetValueOrDefault(p.Name!)).ToArray());
    }

    public void Set(string id, Func<GatewayCharge, GatewayCharge> change) => Charges[id] = change(Charges[id]);
    public void MarkPaid(string id) => Set(id, c => c with { Status = BillingChargeStatus.Paid, PaidAt = DateTimeOffset.UtcNow });
    public string Single() => Assert.Single(Charges.Keys);

    public static void Install(IServiceCollection services, GatePsp psp)
    {
        services.RemoveAll<IBillingGateway>();
        services.AddScoped<IBillingGateway>(provider => GateGatewayProxy.For(psp, provider.GetRequiredService<FluxoDbContext>()));
    }
}

public class GateGatewayProxy : DispatchProxy
{
    private GatePsp psp = null!;
    private FluxoDbContext db = null!;

    internal static IBillingGateway For(GatePsp psp, FluxoDbContext db)
    {
        var proxy = Create<IBillingGateway, GateGatewayProxy>();
        var self = (GateGatewayProxy)(object)proxy;
        (self.psp, self.db) = (psp, db);
        return proxy;
    }

    protected override object? Invoke(MethodInfo? method, object?[]? args)
    {
        Interlocked.Increment(ref psp.Touches);
        if (method!.Name == "get_Provider") return "gate";
        if (psp.Forbidden) throw new InvalidOperationException($"gateway tocado no handler: {method.Name}");
        return method.Name switch
        {
            nameof(IBillingGateway.EnsureCustomerAsync) => EnsureAsync((GatewayCustomerRequest)args![0]!),
            nameof(IBillingGateway.CreatePixChargeAsync) => CreateAsync((GatewayPixChargeRequest)args![0]!),
            nameof(IBillingGateway.FindChargeByReferenceAsync) => FindAsync((string)args![0]!),
            nameof(IBillingGateway.GetChargeAsync) => GetAsync((string)args![0]!),
            nameof(IBillingGateway.RefundAsync) => RefundAsync((string)args![0]!, (long)args[1]!),
            _ when method.ReturnType == typeof(Task<GatewayPixCharge>) => ReadPixAsync(args!.OfType<string>().First()),
            _ => throw new NotSupportedException($"o PSP do gate não conhece {method.Name}: {method}"),
        };
    }

    private async Task CheckAsync(string call)
    {
        if (db.Database.CurrentTransaction is not null) psp.Violations.Enqueue($"{call}: CurrentTransaction aberta");
        if (psp.ProbeApplication is { } application && await GateProbe.OpenTransactionAsync(application) is { } open)
            psp.Violations.Enqueue($"{call}: transação aberta no banco ({open})");
        if (psp.Down) throw new HttpRequestException("psp fora do ar");
    }

    private async Task<GatewayCustomer> EnsureAsync(GatewayCustomerRequest request)
    {
        await CheckAsync("EnsureCustomerAsync");
        Interlocked.Increment(ref psp.Customers);
        return new GatewayCustomer($"cus_{request.ExternalReference}");
    }

    private static GatewayPixCharge Pix(string id, DateTimeOffset expires) => new(id, $"br-{id}", "data:image/png;base64,R0FURQ==", expires);

    private async Task<GatewayPixCharge> CreateAsync(GatewayPixChargeRequest request)
    {
        await CheckAsync("CreatePixChargeAsync");
        Interlocked.Increment(ref psp.Creates);
        await Task.Delay(psp.CreateDelay);
        var id = $"chg_{request.ExternalReference}";
        psp.Charges[id] = GatePsp.Charge(id, request.ExternalReference, request.ExternalCustomerId, request.AmountCents, "BRL", BillingChargeStatus.Pending, null);
        if (psp.FailAfterCreate)
        {
            psp.FailAfterCreate = false;
            throw new HttpRequestException("resposta perdida depois de criar a cobrança");
        }
        return Pix(id, request.ExpiresAt);
    }

    private async Task<GatewayCharge?> FindAsync(string reference)
    {
        await CheckAsync("FindChargeByReferenceAsync");
        Interlocked.Increment(ref psp.Finds);
        return psp.Charges.Values.FirstOrDefault(c => c.ExternalReference == reference);
    }

    private async Task<GatewayCharge> GetAsync(string id)
    {
        await CheckAsync("GetChargeAsync");
        Interlocked.Increment(ref psp.Gets);
        return psp.Charges.TryGetValue(id, out var charge) ? charge : throw new HttpRequestException("cobrança inexistente no PSP");
    }

    private async Task<GatewayPixCharge> ReadPixAsync(string id)
    {
        await CheckAsync("leitura do QR");
        return Pix(id, DateTimeOffset.UtcNow.AddHours(1));
    }

    private async Task<GatewayRefund> RefundAsync(string id, long cents)
    {
        await CheckAsync("RefundAsync");
        Interlocked.Increment(ref psp.Refunds);
        await Task.Delay(psp.RefundDelay);
        psp.Set(id, c => c with { Status = BillingChargeStatus.Refunded });
        return new GatewayRefund($"ref_{id}", id, cents);
    }
}

internal static class GateProbe
{
    public static string Connection(string application) =>
        new NpgsqlConnectionStringBuilder(GateBil.C) { ApplicationName = application, Pooling = false }.ConnectionString;

    /// <summary>Transação da API que segue aberta 250 ms depois: mesmo pid e mesmo xact_start. Trabalho de fundo curto não conta.</summary>
    public static async Task<string?> OpenTransactionAsync(string application)
    {
        var sql = $"SELECT pid::text || ' ' || xact_start::text FROM pg_stat_activity WHERE application_name = '{application}' AND xact_start IS NOT NULL";
        var first = await GateBil.RowsAsync(GateBil.C, sql);
        if (first.Count == 0) return null;
        await Task.Delay(250);
        return (await GateBil.RowsAsync(GateBil.C, sql)).Intersect(first).FirstOrDefault();
    }
}

internal sealed record GateCheckoutState(string BusinessId, string Owner, Guid PriceId, Guid SubscriptionId, Guid InvoiceId, string ExternalChargeId);

internal static class GateCheckout
{
    public const string Job = "--job=billing-reconcile";

    public static Dictionary<string, string?> Settings(params (string Key, string? Value)[] extra) => GateBil.WebhookSettings(
    [
        .. GateCrypto.Keys(), ("Billing:CheckoutEnabled", "true"), ("RateLimiting:Webhooks:AuthenticPermitLimit", "100000"), .. extra,
    ]);

    public static DebateApiFactory Api(GatePsp psp, string? connection = null, Action<IServiceCollection>? more = null, params (string Key, string? Value)[] extra) =>
        new(connection ?? GateBil.C, s => { GatePsp.Install(s, psp); more?.Invoke(s); }, Settings(extra));

    public static async Task<Guid> SeedPriceAsync(long cents = 3900, string interval = "month", bool active = true, string audience = "business")
    {
        await GateBil.ApplyMvpAsync();
        var (product, price, code) = (Guid.NewGuid(), Guid.NewGuid(), $"gate-{Guid.NewGuid():N}");
        await DebateTestDb.ExecAsync(GateBil.C, $"""
            INSERT INTO fluxo.billing_products(id,code,kind,audience,name,sort_order,active,created_at,updated_at)
            VALUES ('{product}','{code}','plan','{audience}','Plano Gate',900,true,now(),now());
            INSERT INTO fluxo.billing_prices(id,product_id,currency,amount_cents,interval,interval_count,trial_days,active,created_at)
            VALUES ('{price}','{product}','BRL',{cents},'{interval}',1,0,{(active ? "true" : "false")},now());
            """);
        return price;
    }

    public static string ProductCode(Guid price) => $"(SELECT p.code FROM fluxo.billing_products p JOIN fluxo.billing_prices x ON x.product_id=p.id WHERE x.id='{price}')";

    public static object Fiscal() => new
    {
        legalName = "Empresa Gate LTDA", taxId = "12.ABC.345/01DE-35", billingEmail = "financeiro@example.test",
        address = new { street = "Rua do Gate", number = "1", district = "Centro", city = "Belo Horizonte", state = "MG", postalCode = "30000000" },
    };

    public static async Task PutFiscalAsync(HttpClient client, string id)
    {
        using var put = await DebateApiFactory.SendAsync(client, HttpMethod.Put, $"/api/v1/billing/subjects/business/{id}/customer", Fiscal());
        Assert.True(put.IsSuccessStatusCode, await put.Content.ReadAsStringAsync());
    }

    public static async Task<HttpResponseMessage> SubscribeAsync(HttpClient client, string id, Guid price, string? key = null)
    {
        var code = await DebateTestDb.ScalarAsync<string>(GateBil.C, $"SELECT {ProductCode(price)}");
        return await DebateApiFactory.SendAsync(client, HttpMethod.Post, $"/api/v1/billing/subjects/business/{id}/subscription", new { productCode = code, priceId = price }, key);
    }

    public static Task<HttpResponseMessage> ChargeAsync(HttpClient client, Guid invoice, string key) =>
        DebateApiFactory.SendAsync(client, HttpMethod.Post, $"/api/v1/billing/invoices/{invoice}/charges", new { }, key);

    /// <summary>Empresa com dado fiscal, assinatura incomplete e cobrança criada no PSP, tudo pelas rotas.</summary>
    public static async Task<GateCheckoutState> OpenAsync(DebateApiFactory factory, GatePsp psp, Guid? price = null)
    {
        var chosen = price ?? await SeedPriceAsync();
        var (id, owner) = await GateBil.SeedBusinessAsync();
        using var client = factory.Client($"user:{owner}");
        await PutFiscalAsync(client, id);
        using var subscribed = await SubscribeAsync(client, id, chosen);
        Assert.Equal(HttpStatusCode.Created, subscribed.StatusCode);
        var body = await GateBil.JsonAsync(subscribed);
        var (subscription, invoice) = (body.GetProperty("subscriptionId").GetGuid(), body.GetProperty("invoiceId").GetGuid());
        var before = psp.Charges.Keys.ToHashSet();
        using var charged = await ChargeAsync(client, invoice, $"chave-{Guid.NewGuid():N}");
        await GateBil.JsonAsync(charged);
        return new GateCheckoutState(id, owner, chosen, subscription, invoice, psp.Charges.Keys.Single(k => !before.Contains(k)));
    }

    public static async Task WebhookAsync(HttpClient client, string charge, string eventType = "PAYMENT_RECEIVED", string? id = null)
    {
        var body = JsonSerializer.Serialize(new { id = id ?? $"evt_{Guid.NewGuid():N}", @event = eventType, payment = new { id = charge } });
        using var response = await client.SendAsync(GateBil.Webhook(GateBil.WebhookPath, body, GateBil.Token));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    public static Task<string?> Text(string sql) => DebateTestDb.ScalarAsync<string>(GateBil.C, sql);
    public static Task<string?> SubscriptionStatus(Guid id) => Text($"SELECT status FROM fluxo.billing_subscriptions WHERE id='{id}'");
    public static Task<string?> InvoiceStatus(Guid id) => Text($"SELECT status FROM fluxo.billing_invoices WHERE id='{id}'");
    public static Task<string?> ChargeStatus(string external) => Text($"SELECT status FROM fluxo.billing_charges WHERE external_charge_id='{external}'");
    public static Task<string?> EventStatus(string id) => Text($"SELECT status FROM fluxo.billing_webhook_events WHERE provider_event_id='{id}'");

    public static Task<long> AuditCountAsync(string subject) => DebateTestDb.ScalarAsync<long>(GateBil.C,
        $"SELECT count(*) FROM fluxo.billing_audit_events WHERE subject_id='{subject}'");

    /// <summary>Tira de cena o que outros testes deixaram: o job percorre a tabela inteira.</summary>
    public static Task QuietAsync() => DebateTestDb.ExecAsync(GateBil.C, """
        UPDATE fluxo.billing_webhook_events SET status='processed' WHERE status IN ('pending','received');
        UPDATE fluxo.billing_charges SET status='failed' WHERE status IN ('pending','refund_pending');
        UPDATE fluxo.billing_subscriptions SET status='canceled', canceled_at=now() WHERE status IN ('incomplete','pending_cancellation') OR cancel_at_period_end;
        """);
}

/// <summary>HTTP falso do Asaas: registra cada chamada e responde pela rota. Sem rota conhecida, 404.</summary>
internal sealed class GateAsaasHttp : HttpMessageHandler
{
    public sealed record Call(string Method, string PathAndQuery, string Body, string? Token, bool Authorization);
    public ConcurrentQueue<Call> Calls { get; } = new();
    public Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>>? Respond { get; set; }

    public static HttpResponseMessage Json(string body, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken);
        Calls.Enqueue(new Call(request.Method.Method, request.RequestUri!.PathAndQuery, body,
            request.Headers.TryGetValues("access_token", out var values) ? values.Single() : null, request.Headers.Authorization is not null));
        return Respond is null ? Json("{}", HttpStatusCode.NotFound) : await Respond(request, cancellationToken);
    }

    public static Action<IServiceCollection> Install(GateAsaasHttp http) => services =>
        services.ConfigureHttpClientDefaults(client => client.ConfigurePrimaryHttpMessageHandler(() => new Forward(http)));

    // O HttpClientFactory descarta o handler primário ao reciclar; o falso precisa sobreviver a isso.
    private sealed class Forward(GateAsaasHttp target) : DelegatingHandler(target)
    {
        protected override void Dispose(bool disposing) { }
    }
}
