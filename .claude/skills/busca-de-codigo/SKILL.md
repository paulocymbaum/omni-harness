---
name: busca-de-codigo
description: Busca de código com o grafo do graphify (graphify query, path, explain, affected) em vez de Grep, Glob, grep -r, rg ou find. Use sempre que precisar achar onde algo está, entender como um fluxo funciona, mapear impacto de uma mudança ou explorar um módulo, antes de abrir arquivos. Também cobre gerar e atualizar o grafo (graphify-out/).
allowed-tools: Read, Bash
---

# Busca de código com graphify

Regra permanente: [.claude/rules/economia-de-tokens.md](../../rules/economia-de-tokens.md). O grafo é a primeira ferramenta; `Read` com `offset`/`limit` vem depois, só nos trechos apontados.

## Consultas

Use **identificadores exatos** (classe, função, arquivo), não frases. O grafo casa por nome de nó; "splash screen build info version" devolve ruído (`info`, `build`, `screen` casam com nós aleatórios), `SplashScreen` devolve o arquivo certo.

```bash
graphify query "SplashScreen" --budget 400                  # símbolo → arquivo, filhos, quem usa
graphify query "CreatorJobAdmission AdmitAsync" --budget 600 # 2-3 identificadores juntos
graphify explain "SplashScreen"                             # o que é, de quem herda, quem referencia
graphify path "SplashScreen" "PackageInfo"                  # caminho entre dois símbolos
graphify affected "applyManifestVersion"                    # impacto da mudança (reverso, depth 2)
graphify god-nodes --top 15                                 # núcleos da arquitetura
```

Saída: `NODE <nome> [src=<arquivo> loc=L<linha>]`.
- C#, TypeScript, JS e Python trazem linha (`loc=L25`): `Read <arquivo> offset=25 limit=40`.
- **Dart não traz linha** (`loc=None`, extrator por regex): `Read` do arquivo com `limit` curto ou `rtk grep -n "<símbolo>" <arquivo>` (busca em arquivo único não é bloqueada) para achar a linha.
- Consulta com nome de arquivo `.dart` genérico (`map_page.dart`) explode em milhares de nós de `dart:io` etc.; consulte o nome da classe.
- `TRUNCATED` na saída: estreite a consulta ou suba `--budget`; não leia os nós cortados com Grep.

## Gerar e manter o grafo

```bash
node quality/agents/graphify-build.mjs                      # primeira vez (offline, sem chave, sob teto de recursos)
node quality/agents/graphify-build.mjs --update             # depois de editar código (offline, incremental)
```

- Use sempre o wrapper: ele limita memória (MemoryMax), CPU e workers (`quality/config/resources.json`) e força `--code-only` (sem ele docs, PDFs e imagens iriam para um LLM). O `graphify extract` solto não tem teto.
- `.graphifyignore` na raiz exclui `docs/`, `assets/`, branding e dados eleitorais. `graphify-out/` fica no `.gitignore`.
- Dart é lido por extrator de regex (classes, funções, imports, chamadas). C# e TypeScript usam tree-sitter. Em `.dart`, confirme com `Read` quando a resposta parecer rasa.

## Quando a busca bruta é aceitável

Depois de uma consulta ao grafo (janela de 30 min), ou quando o grafo não existe. Para texto literal (mensagem de erro, chave de config) o `rtk grep` é aceitável; prefira o grafo para símbolos e fluxos.

O hook **não bloqueia**: no modo suave (padrão) dá uma dica uma vez a cada 30 min quando você usa `Grep`, `Glob **`, `grep -r`, `rg` ou `find -name` sem ter consultado o grafo. Buscas em `docs/`, `*.md`, `*.json` e similares nem recebem a dica (o grafo é só de código). Para o usuário que quiser rigor: `GRAPHIFY_HOOK_MODE=strict` antes de abrir o Claude Code (no Cline o hook nunca cancela: `cancel` aborta a tarefa). Desligar: `GRAPHIFY_HOOK_MODE=off`.
