// Apoio dos gates FC-002 (template). Storage falso em memória por DispatchProxy sobre ICreatorAssetStorage (lido pelo
// nome, então compila antes de a interface existir), construtores de bytes reais de JPEG/PNG/WebP/SVG e chamadas do kit.
// O fake espelha o que GcsDebateAudioStorage faz com os argumentos (content-type e x-goog-content-length-range presos);
// o que o gate prova é o que a API PASSA ao storage, não a criptografia da URL (isso é FC-002-REGRESSAO-DEBATE).
using System.Collections.Concurrent;
using System.Reflection;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Npgsql;

namespace Fluxo.Api.Tests;

public sealed record FakeSign(string Path, string ContentType, long SizeBytes, TimeSpan Lifetime);

public class FakeCreatorStorage : DispatchProxy
{
    public bool Configured { get; set; } = true;
    public ConcurrentDictionary<string, (string ContentType, byte[] Bytes)> Objects { get; } = new();
    public ConcurrentQueue<FakeSign> UploadSigns { get; } = new();
    public ConcurrentQueue<(string Path, TimeSpan Lifetime, string[] Extra)> DownloadSigns { get; } = new();
    public ConcurrentQueue<(string Path, string ContentType, byte[] Bytes)> Written { get; } = new();
    public ConcurrentQueue<string> Deleted { get; } = new();

    public static (FakeCreatorStorage Fake, Action<IServiceCollection> Register) Create()
    {
        var iface = GateFc.Find("ICreatorAssetStorage");
        var create = typeof(DispatchProxy).GetMethods().Single(m => m.Name == nameof(DispatchProxy.Create) && m.GetGenericArguments().Length == 2);
        var proxy = create.MakeGenericMethod(iface, typeof(FakeCreatorStorage)).Invoke(null, null)!;
        var fake = (FakeCreatorStorage)proxy;
        return (fake, services => { services.RemoveAll(iface); services.AddSingleton(iface, proxy); });
    }

    /// <summary>Simula o PUT do navegador na URL assinada: grava os bytes no caminho de staging da última assinatura.</summary>
    public string Put(Guid assetId, string contentType, byte[] bytes)
    {
        var sign = UploadSigns.Reverse().FirstOrDefault(s => s.Path.Contains(assetId.ToString("N"), StringComparison.OrdinalIgnoreCase));
        Assert.True(sign is not null, "a API não pediu URL assinada de upload para este asset (staging/creator/<assetId:N>)");
        Objects[sign!.Path] = (contentType, bytes);
        return sign.Path;
    }

    public IEnumerable<(string Path, string ContentType, byte[] Bytes)> FinalWrites => Written.Where(w => !w.Path.StartsWith("staging/", StringComparison.Ordinal));

    protected override object? Invoke(MethodInfo? method, object?[]? args)
    {
        var name = method!.Name;
        args ??= [];
        var strings = args.OfType<string>().ToArray();
        var lifetime = args.OfType<TimeSpan>().FirstOrDefault();
        if (name == "get_IsConfigured") return Configured;
        if (name.Contains("SignUpload"))
        {
            var size = args.OfType<long>().FirstOrDefault();
            UploadSigns.Enqueue(new FakeSign(strings[0], strings.Length > 1 ? strings[1] : "", size, lifetime));
            var headers = new Dictionary<string, string> { ["content-type"] = strings.Length > 1 ? strings[1] : "", ["x-goog-content-length-range"] = $"0,{size}" };
            return Reply(method, "PUT", headers, lifetime);
        }
        if (name.Contains("SignDownload"))
        {
            DownloadSigns.Enqueue((strings[0], lifetime, strings.Skip(1).ToArray()));
            return Reply(method, "GET", new Dictionary<string, string>(), lifetime);
        }
        if (name.Contains("GetInfo") || name.Contains("Head") || name.Contains("Stat"))
            return Wrap(method, Objects.TryGetValue(strings[0], out var o) ? Build(Inner(method), new() { ["size"] = (long)o.Bytes.Length, ["contenttype"] = o.ContentType }) : null);
        if (name.Contains("Exists")) return Wrap(method, Objects.ContainsKey(strings[0]));
        if (name.Contains("Read"))
            return Wrap(method, Objects.TryGetValue(strings[0], out var r) ? AsReturn(Inner(method), r.Bytes) : null);
        if (name.Contains("Write"))
        {
            var bytes = args.OfType<byte[]>().FirstOrDefault() ?? args.OfType<ReadOnlyMemory<byte>>().Select(m => m.ToArray()).First();
            Objects[strings[0]] = (strings.Length > 1 ? strings[1] : "", bytes);
            Written.Enqueue((strings[0], strings.Length > 1 ? strings[1] : "", bytes));
            return Wrap(method, Inner(method) == typeof(bool) ? true : null);
        }
        if (name.Contains("Delete"))
        {
            Objects.TryRemove(strings[0], out _);
            Deleted.Enqueue(strings[0]);
            return Wrap(method, Inner(method) == typeof(bool) ? true : null);
        }
        throw new NotSupportedException($"fake de ICreatorAssetStorage: método {name} não mapeado pelo gate");
    }

    private static Type? Inner(MethodInfo m) => m.ReturnType.IsGenericType ? m.ReturnType.GetGenericArguments()[0] : null;

    private static object Wrap(MethodInfo method, object? value)
    {
        var inner = Inner(method);
        if (inner is null) return System.Threading.Tasks.Task.CompletedTask;
        var wrapped = value ?? (inner.IsValueType ? Activator.CreateInstance(inner) : null);
        return typeof(Task).GetMethod(nameof(System.Threading.Tasks.Task.FromResult))!.MakeGenericMethod(inner).Invoke(null, [wrapped])!;
    }

    private static object? AsReturn(Type? type, byte[] bytes)
    {
        if (type is null || type == typeof(byte[])) return bytes;
        if (type == typeof(ReadOnlyMemory<byte>)) return new ReadOnlyMemory<byte>(bytes);
        if (typeof(Stream).IsAssignableFrom(type)) return new MemoryStream(bytes);
        throw new NotSupportedException($"ReadAsync devolve {type}: o gate só entende byte[], ReadOnlyMemory<byte> e Stream");
    }

    private object Reply(MethodInfo method, string verb, Dictionary<string, string> headers, TimeSpan lifetime) =>
        Wrap(method, Build(Inner(method)!, new()
        {
            ["url"] = "https://storage.fake.test/signed/" + Guid.NewGuid().ToString("N"), ["method"] = verb, ["headers"] = headers,
            ["expiresat"] = DateTimeOffset.UtcNow + lifetime,
        }));

    /// <summary>Instancia um record/classe preenchendo o construtor por nome (e, na falta, por tipo).</summary>
    private static object? Build(Type? type, Dictionary<string, object?> byName)
    {
        if (type is null) return null;
        var ctor = type.GetConstructors().OrderByDescending(c => c.GetParameters().Length).First();
        var values = ctor.GetParameters().Select(p =>
        {
            var key = byName.Keys.FirstOrDefault(k => p.Name!.ToLowerInvariant().Contains(k));
            if (key is not null && byName[key] is { } v && (p.ParameterType.IsInstanceOfType(v) || p.ParameterType.IsAssignableFrom(v.GetType()))) return v;
            if (p.ParameterType == typeof(DateTimeOffset)) return DateTimeOffset.UtcNow;
            if (p.ParameterType == typeof(string)) return string.Empty;
            if (p.ParameterType == typeof(bool)) return true;
            return p.ParameterType.IsValueType ? Activator.CreateInstance(p.ParameterType) : null;
        }).ToArray();
        return ctor.Invoke(values);
    }
}

internal static class GateFc2
{
    public const string Png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    public const string Webp1x1 = "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";

    public static (DebateApiFactory Factory, FakeCreatorStorage Storage) Api(params (string Key, string? Value)[] extra)
    {
        var (fake, register) = FakeCreatorStorage.Create();
        // Gate corrigido: PermitLimit 100000 derrubava a subida da API (a validação aceita 1..10000); 10000 é o maior valor válido.
        var all = new List<(string, string?)> { ("Creator:AssetBucket", "fluxo-gate-bucket"), ("RateLimiting:PermitLimit", "10000") };
        all.AddRange(extra);
        return (new DebateApiFactory(GateFc.C, register, GateFc.Settings(all.ToArray())), fake);
    }

    public static string Route(string businessId, string path) => $"/api/v1/creator/brand-kit{path}{(path.Contains('?') ? '&' : '?')}businessId={Uri.EscapeDataString(businessId)}";

    public static async Task<(int Status, JsonElement Body, HttpResponseMessage Raw)> CallAsync(HttpClient client, HttpMethod method, string route, object? body = null)
    {
        using var response = await DebateApiFactory.SendAsync(client, method, route, body);
        var text = await response.Content.ReadAsStringAsync();
        var json = string.IsNullOrWhiteSpace(text) ? default : JsonDocument.Parse(text).RootElement.Clone();
        return ((int)response.StatusCode, json, response);
    }

    public static bool Ok(int status) => status is >= 200 and < 300;

    public static async Task<(int Status, JsonElement Body, HttpResponseMessage Raw)> RequestUploadAsync(HttpClient client, string businessId, string purpose,
        string contentType, long size, string fileName = "Logo Final (v2).png", long? original = null) =>
        await CallAsync(client, HttpMethod.Post, Route(businessId, "/assets/uploads"), original is null
            ? new { purpose, fileName, contentType, sizeBytes = size } : new { purpose, fileName, contentType, sizeBytes = size, originalBytes = original });

    /// <summary>Upload completo: pede URL, simula o PUT e chama complete. Devolve o assetId e a resposta do complete.</summary>
    public static async Task<(Guid AssetId, int Status, JsonElement Body)> UploadAsync(HttpClient client, FakeCreatorStorage storage, string businessId,
        string purpose, string contentType, byte[] bytes, string fileName = "arquivo.bin")
    {
        var upload = await RequestUploadAsync(client, businessId, purpose, contentType, bytes.Length, fileName);
        Assert.True(Ok(upload.Status), $"upload recusado: HTTP {upload.Status} {upload.Body}");
        var id = Guid.Parse(upload.Body.GetProperty("assetId").GetString()!);
        storage.Put(id, contentType, bytes);
        var done = await CallAsync(client, HttpMethod.Post, Route(businessId, $"/assets/{id}/complete"));
        return (id, done.Status, done.Body);
    }

    public static async Task<Guid> ReadyAssetAsync(HttpClient client, FakeCreatorStorage storage, string businessId, string purpose = "template", byte[]? bytes = null,
        string contentType = "image/png")
    {
        var (id, status, body) = await UploadAsync(client, storage, businessId, purpose, contentType, bytes ?? Convert.FromBase64String(Png1x1));
        Assert.True(Ok(status), $"complete falhou: HTTP {status} {body}");
        return id;
    }

    public static async Task<(int Status, JsonElement Body, HttpResponseMessage Raw)> CreateTemplateAsync(HttpClient client, string businessId, Guid assetId,
        string preset = "feed_square", string? name = null) =>
        await CallAsync(client, HttpMethod.Post, Route(businessId, "/templates"), new { assetId, viewportPreset = preset, name });

    public static async Task<string?> ScalarAsync(string sql)
    {
        await using var conn = new NpgsqlConnection(GateFc.C);
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(sql, conn);
        var value = await cmd.ExecuteScalarAsync();
        return value is null or DBNull ? null : Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture);
    }

    public static async Task<string[]> RowAsync(string sql)
    {
        await using var conn = new NpgsqlConnection(GateFc.C);
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(sql, conn);
        await using var reader = await cmd.ExecuteReaderAsync();
        Assert.True(await reader.ReadAsync(), $"consulta sem linha: {sql}");
        return Enumerable.Range(0, reader.FieldCount).Select(i => reader.IsDBNull(i) ? "<null>" : Convert.ToString(reader.GetValue(i), System.Globalization.CultureInfo.InvariantCulture)!).ToArray();
    }

    // ───────── bytes reais mínimos ─────────

    private static uint Crc32(byte[] data)
    {
        var crc = 0xFFFFFFFFu;
        foreach (var b in data)
        {
            crc ^= b;
            for (var k = 0; k < 8; k++) crc = (crc & 1) != 0 ? (crc >> 1) ^ 0xEDB88320u : crc >> 1;
        }
        return ~crc;
    }

    private static byte[] Be32(uint v) => [(byte)(v >> 24), (byte)(v >> 16), (byte)(v >> 8), (byte)v];

    private static byte[] PngChunk(string type, byte[] data)
    {
        var typed = Encoding.ASCII.GetBytes(type).Concat(data).ToArray();
        return Be32((uint)data.Length).Concat(typed).Concat(Be32(Crc32(typed))).ToArray();
    }

    /// <summary>PNG com cabeçalho válido (assinatura, IHDR, IDAT mínimo, IEND). Os pixels não são lidos por ninguém.</summary>
    public static byte[] Png(int width, int height) => new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }
        .Concat(PngChunk("IHDR", Be32((uint)width).Concat(Be32((uint)height)).Concat(new byte[] { 8, 2, 0, 0, 0 }).ToArray()))
        .Concat(PngChunk("IDAT", [0x78, 0x9C, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]))
        .Concat(PngChunk("IEND", [])).ToArray();

    public static byte[] PngTruncated() => Png(10, 10)[..20];

    /// <summary>JPEG com SOI, JFIF simples, (EXIF com marcador de GPS), SOF0, SOS com dados e EOI, e lixo depois do EOI.</summary>
    public static byte[] Jpeg(int width, int height, bool exif = false, bool trailer = false)
    {
        var bytes = new List<byte> { 0xFF, 0xD8 };
        bytes.AddRange(new byte[] { 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00 });
        if (exif)
        {
            var payload = Encoding.ASCII.GetBytes("Exif\0\0GPSLatitudeREF-SECRET");
            bytes.AddRange(new byte[] { 0xFF, 0xE1, (byte)((payload.Length + 2) >> 8), (byte)(payload.Length + 2) });
            bytes.AddRange(payload);
        }
        bytes.AddRange(new byte[] { 0xFF, 0xC0, 0x00, 0x11, 0x08, (byte)(height >> 8), (byte)height, (byte)(width >> 8), (byte)width, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01 });
        bytes.AddRange(new byte[] { 0xFF, 0xDA, 0x00, 0x0C, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3F, 0x00, 0x11, 0x22, 0x33, 0xFF, 0xD9 });
        if (trailer) bytes.AddRange(Encoding.ASCII.GetBytes("MP4-TRAILER-SECRET"));
        return bytes.ToArray();
    }

    public static byte[] JpegTruncated() => Jpeg(10, 10)[..24];

    public static byte[] WebpHeader(int width, int height)
    {
        byte[] Le24(int v) => [(byte)v, (byte)(v >> 8), (byte)(v >> 16)];
        var vp8x = new byte[] { 0, 0, 0, 0 }.Concat(Le24(width - 1)).Concat(Le24(height - 1)).ToArray();
        var body = Encoding.ASCII.GetBytes("WEBPVP8X").Concat(BitConverter.GetBytes(vp8x.Length)).Concat(vp8x).ToArray();
        return Encoding.ASCII.GetBytes("RIFF").Concat(BitConverter.GetBytes(body.Length)).Concat(body).ToArray();
    }

    public static byte[] Utf8(string text) => Encoding.UTF8.GetBytes(text);

    public const string SvgOpen = "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 100 100\" width=\"100\" height=\"100\">";

    public static string Svg(string inner) => $"{SvgOpen}{inner}</svg>";

    public static string Hex(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.String) return element.GetString()!;
        foreach (var property in element.EnumerateObject())
            if (property.Value.ValueKind == JsonValueKind.String && System.Text.RegularExpressions.Regex.IsMatch(property.Value.GetString()!, "^#[0-9A-Fa-f]{6}$")) return property.Value.GetString()!;
        throw new Xunit.Sdk.XunitException($"cor sem valor #RRGGBB em {element}");
    }

    // WCAG 2.x, igual à da spec: serve de oráculo para a sugestão de cor.
    public static double Luminance(string hex)
    {
        double Lin(int c) { var s = c / 255.0; return s <= 0.04045 ? s / 12.92 : Math.Pow((s + 0.055) / 1.055, 2.4); }
        var n = Convert.ToInt32(hex.TrimStart('#'), 16);
        return 0.2126 * Lin(n >> 16) + 0.7152 * Lin((n >> 8) & 255) + 0.0722 * Lin(n & 255);
    }

    public static double Ratio(string a, string b)
    {
        var (x, y) = (Luminance(a), Luminance(b));
        return (Math.Max(x, y) + 0.05) / (Math.Min(x, y) + 0.05);
    }
}
