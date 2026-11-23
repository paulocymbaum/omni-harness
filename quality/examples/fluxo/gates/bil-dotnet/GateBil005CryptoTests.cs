// Gate BIL-005-CRIPTO. Template do autor de gates. O protetor vem da DI, e as chaves são geradas no teste.
using System.Reflection;
using System.Security.Cryptography;
using System.Text;

namespace Fluxo.Api.Tests;

public sealed class GateBil005CryptoTests
{
    private const string Aad = "billing_customer:gate:tax_id";

    private static DebateApiFactory Api(string active = "k1", bool withNew = false) => new(settings: GateBil.Settings(GateCrypto.Keys(active, withNew)));

    private static void AssertRefused(GateProtector protector, string envelope, string aad = Aad)
    {
        var error = Assert.ThrowsAny<Exception>(() => protector.Unprotect(envelope, aad));
        Assert.Equal("SensitiveDataException", error.GetType().Name);
        Assert.DoesNotContain("segredo", error.Message);
    }

    [Theory]
    [InlineData("segredo simples")]
    [InlineData("acentuação çãõ € 日本語")]
    public void Round_trip_preserves_text_and_keeps_the_envelope_format(string text)
    {
        using var factory = Api();
        var protector = GateProtector.From(factory);
        var envelope = protector.Protect(text, Aad);
        var parts = envelope.Split('.');
        Assert.Equal(5, parts.Length);
        Assert.Equal(["v1", "k1"], parts[..2]);
        Assert.Equal(12, GateCrypto.FromUrl(parts[2]).Length);
        Assert.Equal(16, GateCrypto.FromUrl(parts[3]).Length);
        Assert.Equal(text, protector.Unprotect(envelope, Aad));
    }

    [Fact]
    public void Same_value_gives_distinct_envelopes_and_same_blind_value()
    {
        using var factory = Api();
        var protector = GateProtector.From(factory);
        Assert.NotEqual(protector.Protect("valor", Aad), protector.Protect("valor", Aad));
        var blind = protector.Blind("VALOR", "billing.tax_id");
        Assert.Equal(blind, protector.Blind("VALOR", "billing.tax_id"));
        Assert.NotEqual(blind, protector.Blind("VALOR", "outro.contexto"));
        Assert.Matches("^[0-9a-f]{64}$", blind);
        var message = Encoding.UTF8.GetBytes("billing.tax_id\0VALOR");
        var accepted = new[] { GateCrypto.HmacKey, Encoding.UTF8.GetBytes(GateCrypto.Url(GateCrypto.HmacKey)) }
            .Select(key => Convert.ToHexStringLower(HMACSHA256.HashData(key, message)));
        Assert.Contains(blind, accepted);
    }

    [Fact]
    public void Wrong_aad_tampering_and_unknown_header_are_refused()
    {
        using var factory = Api();
        var protector = GateProtector.From(factory);
        var envelope = protector.Protect("segredo", Aad);
        AssertRefused(protector, envelope, "outro:aad");
        var parts = envelope.Split('.');
        foreach (var index in new[] { 2, 3, 4 })
        {
            var bytes = GateCrypto.FromUrl(parts[index]);
            bytes[0] ^= 0x01;
            var tampered = (string[])parts.Clone();
            tampered[index] = GateCrypto.Url(bytes);
            AssertRefused(protector, string.Join('.', tampered));
        }
        AssertRefused(protector, string.Join('.', ["v2", .. parts[1..]]));
        AssertRefused(protector, string.Join('.', [parts[0], "desconhecida", .. parts[2..]]));
        AssertRefused(protector, "nao-e-envelope");
    }

    [Fact]
    public void Old_key_still_decrypts_after_rotation_and_new_envelopes_use_the_active_key()
    {
        string envelope;
        using (var before = Api()) envelope = GateProtector.From(before).Protect("segredo", Aad);
        using var after = Api("k2", withNew: true);
        var protector = GateProtector.From(after);
        Assert.Equal("segredo", protector.Unprotect(envelope, Aad));
        Assert.Equal("k2", protector.Protect("novo", Aad).Split('.')[1]);
    }

    [Fact]
    public void Envelope_built_like_the_function_is_accepted_with_the_key_id_added()
    {
        var (iv, tag) = (RandomNumberGenerator.GetBytes(12), new byte[16]);
        var plain = Encoding.UTF8.GetBytes("segredo da function");
        var cipher = new byte[plain.Length];
        using (var aes = new AesGcm(GateCrypto.OldKey, 16)) aes.Encrypt(iv, plain, cipher, tag, Encoding.UTF8.GetBytes(Aad));
        using var factory = Api();
        var envelope = string.Join('.', "v1", "k1", GateCrypto.Url(iv), GateCrypto.Url(tag), GateCrypto.Url(cipher));
        Assert.Equal("segredo da function", GateProtector.From(factory).Unprotect(envelope, Aad));
    }

    [Fact]
    public void Business_exposes_normalize_and_mask_with_the_current_format()
    {
        var type = GateBil.Find("Business");
        var normalize = type.GetMethod("NormalizeCnpj", BindingFlags.Public | BindingFlags.Static);
        var mask = type.GetMethod("MaskCnpj", BindingFlags.Public | BindingFlags.Static);
        Assert.True(normalize is not null && mask is not null, "Business precisa expor NormalizeCnpj e MaskCnpj públicos e estáticos");
        Assert.Equal("12ABC34501DE35", normalize!.Invoke(null, ["12.abc.345/01de-35"]));
        Assert.Equal("**.***.345/****-35", mask!.Invoke(null, ["12ABC34501DE35"]));
    }
}
