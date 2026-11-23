// Apoio dos gates BIL-010 e BIL-011. Template do autor de gates. O contrato com o Asaas vem da spec, então a prova passa pelo gateway real sobre
// um Asaas de mentira em memória, com HTTP falso em host .invalid: nada sai para a rede, e os tipos novos da porta não aparecem aqui.
// Pix Automático real não é provado por este arquivo: fica em BIL-010-CONTA-PIX-AUTOMATICO, manual.
// Nomes do Asaas assumidos da documentação pública lida na Fase A: conferir no gate manual (authorization, paymentInstruction, conciliationIdentifier).
using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Fluxo.Api.Tests;

internal sealed class GateClock(DateTimeOffset now) : TimeProvider
{
    public DateTimeOffset Now { get; set; } = now;
    public override DateTimeOffset GetUtcNow() => Now;
}

internal sealed class GateFakeAsaas
{
    public sealed class Payment
    {
        public required string Id;
        public required string Customer;
        public required decimal Value;
        public string Status = "PENDING";
        public string? ExternalReference, Authorization, Instruction, DueDate, PaymentDate, Conciliation;
        public bool Deleted;
    }

    public sealed record Retry(string Instruction, string DueDate, string Body, DateTimeOffset At);
    public sealed class Invoice
    {
        public required string Id;
        public string Status = "SCHEDULED";
        public string? Payment, ExternalReference, Number, PdfUrl, XmlUrl;
    }

    private int sequence;
    private string Next(string prefix) => $"{prefix}_{Interlocked.Increment(ref sequence)}_{Guid.NewGuid():N}"[..24];

    public GateAsaasHttp Http { get; } = new();
    public ConcurrentDictionary<string, Payment> Payments { get; } = new();
    public ConcurrentDictionary<string, string> Customers { get; } = new();
    public ConcurrentDictionary<string, string> Authorizations { get; } = new();
    public ConcurrentDictionary<string, string> Instructions { get; } = new();
    public ConcurrentDictionary<string, Invoice> Invoices { get; } = new();
    public ConcurrentQueue<Retry> Retries { get; } = new();
    /// <summary>Autorizações já entregues a um teste: o mesmo PSP de mentira atende mais de uma empresa.</summary>
    public HashSet<string> Handed { get; } = [];
    public ConcurrentQueue<string> Violations { get; } = new();
    public HttpStatusCode? RetryFailure, AuthorizationFailure;
    public bool AnswerAuthorizationWithoutConciliation, InvoiceLostAfterCreate, InvoicesDown;
    public int ProbeCalls;
    /// <summary>Application Name das conexões da API: liga a sonda de pg_stat_activity em toda chamada ao PSP.</summary>
    public string? ProbeApplication;
    public Func<DateTimeOffset> Clock = () => DateTimeOffset.UtcNow;

    public GateFakeAsaas() => Http.Respond = RespondAsync;

    public static string Text(JsonObject body, string key) => body[key]?.GetValue<string>() ?? "";

    private JsonObject ToJson(Payment p) => new()
    {
        ["object"] = "payment", ["id"] = p.Id, ["customer"] = p.Customer, ["value"] = p.Value, ["netValue"] = p.Value, ["billingType"] = "PIX", ["status"] = p.Status,
        ["dueDate"] = p.DueDate, ["externalReference"] = p.ExternalReference, ["deleted"] = p.Deleted, ["paymentDate"] = p.PaymentDate,
        ["pixAutomaticAuthorizationId"] = p.Authorization, ["conciliationIdentifier"] = p.Conciliation, ["invoiceUrl"] = $"https://asaas.gate.invalid/i/{p.Id}",
    };

    private static JsonObject List(IEnumerable<JsonNode> items) => new() { ["object"] = "list", ["data"] = new JsonArray(items.ToArray()) };

    private static HttpResponseMessage Json(JsonNode body, HttpStatusCode status = HttpStatusCode.OK) => GateAsaasHttp.Json(body.ToJsonString(), status);

    private static HttpResponseMessage Error(HttpStatusCode status, string code) => Json(JsonNode.Parse($$"""{"errors":[{"code":"{{code}}","description":"gate"}]}""")!, status);

    /// <summary>Cobrança que o Asaas cria sozinho na Jornada 3: sem externalReference do Fluxo.</summary>
    public Payment FirstCharge(string customer, decimal value, string status = "RECEIVED", string? conciliation = null)
    {
        var payment = new Payment { Id = Next("pay"), Customer = customer, Value = value, Status = status, Conciliation = conciliation, PaymentDate = Clock().ToOffset(TimeSpan.FromHours(-3)).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) };
        Payments[payment.Id] = payment;
        return payment;
    }

    public void Pay(string id, string status = "RECEIVED")
    {
        Payments[id].Status = status;
        Payments[id].PaymentDate = Clock().ToOffset(TimeSpan.FromHours(-3)).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
    }

    public IEnumerable<GateAsaasHttp.Call> Posts(string path) => Http.Calls.Where(c => c.Method == "POST" && c.PathAndQuery.StartsWith(path, StringComparison.Ordinal));

    public bool AuthorizationCanceled(string id) => Http.Calls.Any(c => c.PathAndQuery.StartsWith($"/v3/pix/automatic/authorizations/{id}", StringComparison.Ordinal) && c.Method is "DELETE" or "POST");

    private async Task<HttpResponseMessage> RespondAsync(HttpRequestMessage request, CancellationToken ct)
    {
        if (ProbeApplication is { } application)
        {
            Interlocked.Increment(ref ProbeCalls);
            if (await GateProbe.OpenTransactionAsync(application) is { } open) Violations.Enqueue($"{request.Method} {request.RequestUri!.AbsolutePath}: transação aberta no banco ({open})");
        }
        var path = request.RequestUri!.AbsolutePath;
        var query = System.Web.HttpUtility.ParseQueryString(request.RequestUri.Query);
        var text = request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct);
        var body = text.Length > 0 ? JsonNode.Parse(text)!.AsObject() : [];
        var segments = path.Trim('/').Split('/')[1..];
        var method = request.Method.Method;
        return (method, segments) switch
        {
            ("GET", ["customers"]) => Json(List(Customers.Where(x => x.Value == query["externalReference"]).Select(x => (JsonNode)new JsonObject { ["id"] = x.Key }))),
            ("POST", ["customers"]) => CreateCustomer(body),
            ("POST", ["payments"]) => CreatePayment(body),
            ("GET", ["payments"]) => Json(List(Payments.Values.Where(p => p.ExternalReference == query["externalReference"]).Select(p => (JsonNode)ToJson(p)))),
            ("GET", ["payments", var id, "pixQrCode"]) => Payments.ContainsKey(id)
                ? Json(new JsonObject { ["encodedImage"] = "R0FURQ==", ["payload"] = $"br-{id}", ["expirationDate"] = Clock().AddDays(1).ToOffset(TimeSpan.FromHours(-3)).ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) })
                : Error(HttpStatusCode.NotFound, "not_found"),
            ("GET", ["payments", var id]) => Payments.TryGetValue(id, out var p) ? Json(ToJson(p)) : Error(HttpStatusCode.NotFound, "not_found"),
            ("DELETE", ["payments", var id]) => Delete(id),
            ("POST", ["pix", "automatic", "authorizations"]) => CreateAuthorization(body),
            ("GET", ["pix", "automatic", "authorizations", var id]) => Json(new JsonObject { ["id"] = id, ["status"] = Authorizations.GetValueOrDefault(id, "CREATED") }),
            ("DELETE", ["pix", "automatic", "authorizations", var id]) => CancelAuthorization(id),
            ("POST", ["pix", "automatic", "authorizations", var id, "cancel"]) => CancelAuthorization(id),
            ("GET", ["pix", "automatic", "paymentInstructions", var id]) => Json(new JsonObject { ["id"] = id, ["status"] = Instructions.GetValueOrDefault(id, "SCHEDULED"), ["paymentId"] = Payments.Values.FirstOrDefault(x => x.Instruction == id)?.Id }),
            ("POST", ["pix", "automatic", "paymentInstructions", var id, "retries"]) => CreateRetry(id, body, text),
            ("POST", ["invoices"]) => CreateInvoice(body),
            ("GET", ["invoices"]) => InvoicesDown ? Error(HttpStatusCode.ServiceUnavailable, "down") : Json(List(Invoices.Values
                .Where(i => (query["externalReference"] is null || i.ExternalReference == query["externalReference"]) && (query["payment"] is null || i.Payment == query["payment"]))
                .Select(i => (JsonNode)ToJson(i)))),
            ("GET", ["invoices", var id]) => Invoices.TryGetValue(id, out var invoice) ? Json(ToJson(invoice)) : Error(HttpStatusCode.NotFound, "not_found"),
            _ => Error(HttpStatusCode.NotFound, "not_found"),
        };
    }

    private HttpResponseMessage CreateCustomer(JsonObject body)
    {
        var id = Next("cus");
        Customers[id] = Text(body, "externalReference");
        return Json(new JsonObject { ["id"] = id });
    }

    private HttpResponseMessage CreatePayment(JsonObject body)
    {
        var authorization = body["pixAutomaticAuthorizationId"]?.GetValue<string>();
        var payment = new Payment
        {
            Id = Next("pay"), Customer = Text(body, "customer"), Value = body["value"]!.GetValue<decimal>(), DueDate = Text(body, "dueDate"),
            ExternalReference = Text(body, "externalReference"), Authorization = authorization, Instruction = authorization is null ? null : Next("ins"),
        };
        Payments[payment.Id] = payment;
        if (payment.Instruction is not null) Instructions[payment.Instruction] = "SCHEDULED";
        return Json(ToJson(payment));
    }

    private HttpResponseMessage Delete(string id)
    {
        if (!Payments.TryGetValue(id, out var payment)) return Error(HttpStatusCode.NotFound, "not_found");
        payment.Deleted = true;
        return Json(new JsonObject { ["deleted"] = true, ["id"] = id });
    }

    private HttpResponseMessage CreateAuthorization(JsonObject body)
    {
        if (AuthorizationFailure is { } failure) return Error(failure, "invalid_action");
        var id = Next("aut");
        Authorizations[id] = "CREATED";
        return Json(new JsonObject
        {
            ["id"] = id, ["status"] = "CREATED", ["payload"] = $"br-{id}", ["encodedImage"] = "R0FURQ==", ["contractId"] = body["contractId"]?.DeepClone(),
            ["conciliationIdentifier"] = AnswerAuthorizationWithoutConciliation ? null : $"con-{id}",
        });
    }

    private HttpResponseMessage CancelAuthorization(string id)
    {
        Authorizations[id] = "CANCELLED";
        return Json(new JsonObject { ["id"] = id, ["status"] = "CANCELLED" });
    }

    private HttpResponseMessage CreateRetry(string id, JsonObject body, string text)
    {
        Retries.Enqueue(new Retry(id, Text(body, "dueDate"), text, Clock()));
        if (RetryFailure is { } failure) return Error(failure, "invalid_action");
        Instructions[id] = "SCHEDULED";
        return Json(new JsonObject { ["id"] = id, ["status"] = "SCHEDULED" });
    }

    private JsonObject ToJson(Invoice i) => new()
    {
        ["object"] = "invoice", ["id"] = i.Id, ["status"] = i.Status, ["payment"] = i.Payment, ["externalReference"] = i.ExternalReference, ["number"] = i.Number, ["pdfUrl"] = i.PdfUrl, ["xmlUrl"] = i.XmlUrl,
    };

    private HttpResponseMessage CreateInvoice(JsonObject body)
    {
        if (InvoicesDown) return Error(HttpStatusCode.ServiceUnavailable, "down");
        var invoice = new Invoice { Id = Next("inv"), Payment = Text(body, "payment"), ExternalReference = Text(body, "externalReference") };
        Invoices[invoice.Id] = invoice;
        if (!InvoiceLostAfterCreate) return Json(ToJson(invoice));
        InvoiceLostAfterCreate = false;
        return Error(HttpStatusCode.BadGateway, "lost_after_create");
    }
}

internal sealed record GateAuto(string BusinessId, string Owner, Guid Subscription, Guid Invoice, string Customer, string Authorization, decimal Value, HttpClient Client);

internal static class GateRecurrence
{
    public const string Renew = "--job=billing-renew";
    public const string Dunning = "--job=billing-dunning";
    public const string Prefix = "PIX_AUTOMATIC_RECURRING_";
    public const long Cents = 3900;
    public const decimal Value = 39m;

    /// <summary>Meio-dia em UTC: a mesma data no Brasil, longe da virada do dia que o Asaas usa.</summary>
    public static DateTimeOffset Noon(int days = 0) => new DateTimeOffset(DateTime.UtcNow.Date, TimeSpan.Zero).AddHours(12).AddDays(days);

    public static string Date(DateTimeOffset moment) => moment.ToOffset(TimeSpan.FromHours(-3)).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    public static DebateApiFactory Api(GateFakeAsaas fake, GateClock clock, string? connection = null, bool automatic = true, Action<IServiceCollection>? more = null, params (string Key, string? Value)[] extra)
    {
        fake.Clock = () => clock.Now;
        (string, string?)[] settings = [("Billing:Provider", "asaas"), ("Asaas:BaseUrl", "https://asaas.gate.invalid/v3"), ("Asaas:ApiKey", "gate-api-key-nao-real"),
            ("Billing:PixAutomaticoEnabled", automatic ? "true" : "false"), .. extra];
        return new DebateApiFactory(connection ?? GateBil.C, services =>
        {
            GateAsaasHttp.Install(fake.Http)(services);
            services.RemoveAll<TimeProvider>();
            services.AddSingleton<TimeProvider>(clock);
            more?.Invoke(services);
        }, GateCheckout.Settings(settings));
    }

    public static async Task<(string Id, string Owner, Guid Subscription, Guid Invoice, HttpClient Client)> SubscribeAsync(DebateApiFactory factory)
    {
        var price = await GateCheckout.SeedPriceAsync(Cents);
        var (id, owner) = await GateBil.SeedBusinessAsync();
        var client = factory.Client($"user:{owner}");
        await GateCheckout.PutFiscalAsync(client, id);
        using var subscribed = await GateCheckout.SubscribeAsync(client, id, price);
        Assert.Equal(HttpStatusCode.Created, subscribed.StatusCode);
        var body = await GateBil.JsonAsync(subscribed);
        return (id, owner, body.GetProperty("subscriptionId").GetGuid(), body.GetProperty("invoiceId").GetGuid(), client);
    }

    public static Task<HttpResponseMessage> ChargeAsync(HttpClient client, Guid invoice, string rail, string? key = null) =>
        DebateApiFactory.SendAsync(client, HttpMethod.Post, $"/api/v1/billing/invoices/{invoice}/charges", new { rail }, key ?? $"chave-{Guid.NewGuid():N}");

    /// <summary>Jornada 3 até a autorização criada no PSP: assinatura incomplete, QR na tela, nada pago.</summary>
    public static async Task<GateAuto> AuthorizeAsync(DebateApiFactory factory, GateFakeAsaas fake)
    {
        var (id, owner, subscription, invoice, client) = await SubscribeAsync(factory);
        using var charged = await ChargeAsync(client, invoice, "pix_automatico");
        await GateBil.JsonAsync(charged);
        var authorization = fake.Authorizations.Keys.Except(fake.Handed).SingleOrDefault();
        Assert.True(authorization is not null, "POST /charges com rail pix_automatico não criou autorização em /v3/pix/automatic/authorizations");
        fake.Handed.Add(authorization);
        var customer = JsonDocument.Parse(fake.Posts("/v3/pix/automatic/authorizations").Last().Body).RootElement.GetProperty("customerId").GetString()!;
        return new GateAuto(id, owner, subscription, invoice, customer, authorization, Value, client);
    }

    /// <summary>Paga a primeira cobrança pelo evento do Asaas e ativa a autorização: fim da Jornada 3.</summary>
    public static async Task<GateFakeAsaas.Payment> PayFirstAsync(HttpClient webhook, GateFakeAsaas fake, GateAuto state, bool activate = true)
    {
        var payment = fake.FirstCharge(state.Customer, state.Value);
        await EventAsync(webhook, "PAYMENT_RECEIVED", "payment", new { id = payment.Id });
        if (activate)
        {
            fake.Authorizations[state.Authorization] = "ACTIVE";
            await EventAsync(webhook, $"{Prefix}AUTHORIZATION_ACTIVATED", "authorization", new { id = state.Authorization });
        }
        return payment;
    }

    public static async Task<string> EventAsync(HttpClient client, string type, string key, object value, string? id = null)
    {
        var eventId = id ?? $"evt_{Guid.NewGuid():N}";
        var body = JsonSerializer.Serialize(new Dictionary<string, object> { ["id"] = eventId, ["event"] = type, [key] = value });
        using var response = await client.SendAsync(GateBil.Webhook(GateBil.WebhookPath, body, GateBil.Token));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return eventId;
    }

    public static async Task RunAsync(DebateApiFactory factory, string job) => Assert.True(await Fluxo.Api.Modules.Billing.BillingJobs.TryRunAsync([job], factory.Services), $"{job} não é um job conhecido");

    public static Task<string?> Instrument(string authorization) => GateCheckout.Text($"SELECT status FROM fluxo.billing_instruments WHERE pix_authorization_id='{authorization}'");
    public static Task<string?> Rail(Guid subscription) => GateCheckout.Text($"SELECT rail FROM fluxo.billing_subscriptions WHERE id='{subscription}'");
    /// <summary>O Npgsql devolve timestamptz como DateTime em UTC.</summary>
    public static async Task<DateTimeOffset> Moment(string sql) => new(DateTime.SpecifyKind(await DebateTestDb.ScalarAsync<DateTime>(GateBil.C, sql), DateTimeKind.Utc));
    public static Task<DateTimeOffset> PeriodEnd(Guid subscription) => Moment($"SELECT current_period_end FROM fluxo.billing_subscriptions WHERE id='{subscription}'");
    public static Task<long> Count(string sql) => DebateTestDb.ScalarAsync<long>(GateBil.C, sql);

    /// <summary>Os jobs percorrem a tabela inteira: nada de outro teste pode entrar na conta do PSP deste.</summary>
    public static async Task QuietAsync()
    {
        await GateBil.ApplyMvpAsync();
        await GateCheckout.QuietAsync();
        await DebateTestDb.ExecAsync(GateBil.C, """
            UPDATE fluxo.billing_invoices SET status='void' WHERE status='open';
            UPDATE fluxo.billing_subscriptions SET status='canceled', canceled_at=now() WHERE status NOT IN ('canceled','incomplete_expired');
            """);
    }

    /// <summary>Assinatura ativa em Pix Automático, relógio em D-7 e renovação rodada: cobrança do ciclo criada no Asaas.</summary>
    public static async Task<(GateAuto State, GateFakeAsaas.Payment Renewal, DateTimeOffset Due, Guid Invoice)> RenewedAsync(DebateApiFactory factory, GateFakeAsaas fake, GateClock clock)
    {
        var state = await AuthorizeAsync(factory, fake);
        using var webhook = factory.CreateClient();
        await PayFirstAsync(webhook, fake, state);
        var due = await PeriodEnd(state.Subscription);
        clock.Now = due.AddDays(-7);
        var before = fake.Payments.Keys.ToHashSet();
        await RunAsync(factory, Renew);
        var renewal = fake.Payments.Values.Single(p => !before.Contains(p.Id));
        var invoice = await DebateTestDb.ScalarAsync<Guid>(GateBil.C, $"SELECT invoice_id FROM fluxo.billing_charges WHERE external_charge_id='{renewal.Id}'");
        return (state, renewal, due, invoice);
    }

    public static Task PassAsync(DebateApiFactory factory, GateClock clock, DateTimeOffset due, int day)
    {
        clock.Now = due.AddDays(day);
        return RunAsync(factory, Dunning);
    }
}
