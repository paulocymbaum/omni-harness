// Apoio dos gates FC-001. Template do autor de gates: copiado para backend/tests/Fluxo.Api.Tests só durante o gate.
// Tipos do módulo Creator são lidos por reflexão e pelo nome simples: compila antes de o módulo existir, e o teste falha
// dizendo o que falta. Nada aqui chama rede nem usa credencial real.
using System.Reflection;
using System.Text.Json;
using Fluxo.Api.Infrastructure.Persistence;
using Fluxo.Api.Modules.FluxoEmpresas;

namespace Fluxo.Api.Tests;

internal static class GateFc
{
    public static string C => DebateTestDb.Connection;

    public static Type Find(string name)
    {
        var found = typeof(FluxoDbContext).Assembly.GetTypes().Where(t => t.Name == name).ToArray();
        Assert.True(found.Length == 1, $"tipo {name}: esperava 1 no assembly da API, encontrei {found.Length}");
        return found[0];
    }

    public static string Norm(string value) => value.Replace("_", "", StringComparison.Ordinal).Replace(".", "", StringComparison.Ordinal).ToLowerInvariant();

    /// <summary>Valor do enum cujo nome C# equivale ao wire (aceita prefixo "creator" no nome, como em creator.read).</summary>
    public static object Pick(Type enumType, string wire)
    {
        var match = Enum.GetNames(enumType).SingleOrDefault(n => Norm(n) == Norm(wire) || "creator" + Norm(n) == Norm(wire));
        Assert.True(match is not null, $"{enumType.Name} sem valor equivalente a '{wire}'");
        return Enum.Parse(enumType, match!);
    }

    public static Dictionary<string, string?> Settings(params (string Key, string? Value)[] extra)
    {
        // FC-017: Homologacao:Creator existe e fecha o Creator por padrão; "Open" vale em Testing e mantém os gates FC-001, FC-002, FC-004 e FC-011 como antes.
        var values = new Dictionary<string, string?> { ["Creator:Enabled"] = "true", ["Homologacao:Creator:Mode"] = "Open" };
        foreach (var (key, value) in extra) values[key] = value;
        return values;
    }

    public static async Task<(string Id, string OwnerUid)> SeedBusinessAsync()
    {
        await DebateTestDb.EnsureAsync();
        var key = Guid.NewGuid().ToString("N");
        var (profile, id, owner) = (Guid.NewGuid(), $"gatefc-{key}", $"owner-{key}");
        await DebateTestDb.ExecAsync(C, $"""
            INSERT INTO fluxo.profiles(id,firebase_uid,display_name,locale,created_at,updated_at)
            VALUES ('{profile}','{owner}','Dona Gate','pt-BR',now(),now());
            INSERT INTO fluxo.businesses(id,owner_profile_id,slug,display_name,status,created_at,updated_at)
            VALUES ('{id}','{profile}','{id}','Empresa Gate','Active',now(),now());
            """);
        return (id, owner);
    }

    public static async Task<string> SeedMemberAsync(string businessId, string role)
    {
        var uid = $"{role.ToLowerInvariant()}-{Guid.NewGuid():N}";
        await using var db = DebateTestDb.Context();
        // Papel legado fora da política (ex.: OPERATOR) é semeado como está, sem permissões: PermissionsFor só aceita papéis atribuíveis.
        var assignable = role is "OWNER" or "ADMIN" or "EDITOR" or "VIEWER";
        string[] permissions = assignable ? BusinessTeamPolicy.PermissionsFor(role) : [];
        db.BusinessTeamMembers.Add(BusinessTeamMember.Create(businessId, uid, role, permissions, "active", DateTimeOffset.UtcNow));
        await db.SaveChangesAsync();
        return uid;
    }

    public static async Task<(int Status, JsonElement Body, HttpResponseMessage Raw)> GetAsync(HttpClient client, string route)
    {
        var response = await client.GetAsync(route);
        var text = await response.Content.ReadAsStringAsync();
        var body = string.IsNullOrWhiteSpace(text) ? default : JsonDocument.Parse(text).RootElement.Clone();
        return ((int)response.StatusCode, body, response);
    }

    public static string? Code(JsonElement body) =>
        body.ValueKind == JsonValueKind.Object && body.TryGetProperty("code", out var code) ? code.GetString() : null;

    public static IEnumerable<string> PropertyNames(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
            foreach (var property in element.EnumerateObject())
            {
                yield return property.Name;
                foreach (var inner in PropertyNames(property.Value)) yield return inner;
            }
        else if (element.ValueKind == JsonValueKind.Array)
            foreach (var item in element.EnumerateArray())
                foreach (var inner in PropertyNames(item)) yield return inner;
    }

    public static string[] Strings(JsonElement array) => array.EnumerateArray().Select(e => e.GetString()!).ToArray();

    /// <summary>Caminho de configuração (Creator:...:Nome) de uma chave que já vive no appsettings.json, onde quer que a implementação a ponha.</summary>
    public static string KeyOf(string name)
    {
        string? file = null;
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "backend", "src", "Fluxo.Api", "appsettings.json");
            if (File.Exists(candidate)) { file = candidate; break; }
        }
        Assert.True(file is not null, "appsettings.json da API não encontrado");
        using var doc = JsonDocument.Parse(File.ReadAllText(file!));
        Assert.True(doc.RootElement.TryGetProperty("Creator", out var section), "appsettings.json sem seção Creator");
        string? Find(JsonElement element, string path)
        {
            if (element.ValueKind != JsonValueKind.Object) return null;
            foreach (var property in element.EnumerateObject())
            {
                if (property.Name == name) return $"{path}:{name}";
                var inner = Find(property.Value, $"{path}:{property.Name}");
                if (inner is not null) return inner;
            }
            return null;
        }
        var key = Find(section, "Creator");
        Assert.True(key is not null, $"seção Creator sem {name} (limite deve vir da configuração)");
        return key!;
    }

    /// <summary>A subida da API com configuração inválida deve falhar citando Creator (e, se dado, o trecho esperado).</summary>
    public static void AssertStartupFails(Dictionary<string, string?> settings, string? mention = null)
    {
        using var factory = new DebateApiFactory(null, settings: settings);
        var error = Assert.ThrowsAny<Exception>(() => factory.CreateClient());
        Assert.Contains("Creator", error.ToString());
        if (mention is not null) Assert.Contains(mention, error.ToString());
    }

    /// <summary>Catálogo estrutural das tabelas (colunas com tipo, nulidade e default; constraints com definição; índices com definição), para paridade SQL x migration.</summary>
    public static async Task<string> CatalogAsync(string connection, params string[] tables)
    {
        await using var conn = new Npgsql.NpgsqlConnection(connection);
        await conn.OpenAsync();
        var lines = new List<string>();
        foreach (var table in tables)
        {
            foreach (var sql in new[]
            {
                $"""
                SELECT 'col ' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull::text || ' ' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
                FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                WHERE n.nspname = 'fluxo' AND c.relname = '{table}' AND a.attnum > 0 AND NOT a.attisdropped ORDER BY 1
                """,
                $"SELECT 'con ' || k.conname || ' ' || pg_get_constraintdef(k.oid) FROM pg_constraint k WHERE k.conrelid = 'fluxo.{table}'::regclass ORDER BY 1",
                $"SELECT 'idx ' || indexname || ' ' || indexdef FROM pg_indexes WHERE schemaname = 'fluxo' AND tablename = '{table}' ORDER BY 1",
            })
            {
                await using var cmd = new Npgsql.NpgsqlCommand(sql, conn);
                await using var reader = await cmd.ExecuteReaderAsync();
                while (await reader.ReadAsync()) lines.Add($"{table}|{reader.GetString(0)}");
            }
        }
        return string.Join('\n', lines);
    }
}
