<!-- GERADO por quality/agents/sync-clinerules.mjs a partir de .claude/rules/economia-de-tokens.md. Não edite aqui. -->

# Regra de economia de tokens — busca, shell e resposta

Aplicada em toda sessão (Claude Code, Cline e demais agentes). Fonte única: este arquivo; o espelho do Cline em `.clinerules/` é gerado por `node quality/agents/sync-clinerules.mjs`.

## 1. Buscar código: graphify primeiro

O repositório tem ~5,8 mil arquivos. Busca bruta (`Grep`, `Glob **`, `grep -r`, `rg`, `find -name`) devolve páginas de ruído. Use o grafo:

| Pergunta | Comando |
|---|---|
| "Onde fica / como funciona X?" | `graphify query "X"` |
| "Como A chega em B?" | `graphify path "A" "B"` |
| "O que é este símbolo/arquivo?" | `graphify explain "X"` |
| "O que quebra se eu mudar X?" | `graphify affected "X"` |
| Visão geral da arquitetura | `graphify god-nodes` (e só então `graphify-out/GRAPH_REPORT.md`) |

Consulte por **identificador exato** (`SplashScreen`, `CreatorJobAdmission AdmitAsync`), não por frase: o grafo casa por nome de nó. Depois leia **só** o trecho apontado: `Read` com `offset`/`limit`. Nunca leia arquivo grande inteiro (`map_page.dart` tem mais de 9 000 linhas).

- Grafo ausente ou velho: `node quality/agents/graphify-build.mjs` (primeira vez) ou `node quality/agents/graphify-build.mjs --update` (depois de editar código). O wrapper roda sob o teto de memória e CPU dos gates e sem chave de API. Nunca rode `graphify extract` solto (abre núcleos-1 processos e pode mandar docs a um LLM sem `--code-only`).
- Dart usa extrator por regex: acha o arquivo e a classe, mas **sem número de linha** (`loc=None`). C#, TypeScript, JS e Python trazem linha. Em `.dart`, ache a linha com `rtk grep -n "<símbolo>" <arquivo>` (arquivo único) ou `Read` curto.
- O hook (Claude Code: `quality/hooks/pre-bash-dispatch.mjs`; Cline: `.clinerules/hooks/PreToolUse`, extensão com "Enable Hooks" ligado, CLI e SDK, só macOS e Linux) **dá uma dica, não bloqueia**: no modo suave (padrão) avisa **uma vez a cada 30 min** que o grafo existe e a busca segue normalmente. Nunca pare por causa dele. Sem grafo, sem a CLI, ou em busca fora do código (`docs/`, `*.md`, `*.json`, `--include=*.md`), nada acontece. `Read` de arquivo específico nunca é tratado como busca.
- Modos, definidos no ambiente **antes** de abrir o agente: `GRAPHIFY_HOOK_MODE=soft` (padrão), `strict` (só Claude Code: nega a busca bruta até uma consulta bem-sucedida; no Cline vira dica a cada busca, porque `cancel` lá **aborta a tarefa inteira**) e `off`. A janela de 30 min só abre depois de um `graphify query|path|explain|affected` que terminou com sucesso e trouxe resultado.

## 2. Shell: rtk

`rtk <comando>` filtra a saída (git, gh, testes, lint, docker, dotnet, find, grep…) e corta até 90% dos tokens.

- Claude Code: o hook `quality/hooks/pre-bash-rtk.mjs` reescreve sozinho (`git status` vira `rtk git status`). Nada a fazer.
- Cline CLI/SDK: o mesmo hook (`.clinerules/hooks/PreToolUse`) reescreve o input de `run_commands` via `overrideInput`.
- Extensão VS Code do Cline (o hook dela não aceita reescrita) e agentes sem hook: **prefixe você mesmo** os comandos ruidosos: `rtk git status`, `rtk git diff`, `rtk test <cmd>`, `rtk err <cmd>`, `rtk read <arquivo>`, `rtk ls`, `rtk grep`, `rtk find`. Comando que precisa da saída crua: `rtk proxy <cmd>`.
- Métricas: `rtk gain`. Oportunidades perdidas: `rtk discover`.

## 3. Resposta concisa (modo "caveman")

Fale pouco, com precisão total. Corte enrolação, não conteúdo técnico. Detalhes e níveis: skill `modo-conciso`.

- Corte: preâmbulo ("vou fazer…"), elogio, recapitulação do que o usuário disse, hedging, repetição do diff que o usuário já vê.
- Fragmento basta. Padrão: `[coisa] [ação] [motivo]. [próximo passo].`
- Termos técnicos, nomes de arquivo, símbolos e comandos ficam exatos. Idioma: pt-BR.
- Exemplo. Ruim: "Claro! Analisei o código e percebi que o problema provavelmente está no componente de rodapé, que não recebia a versão." Bom: "Rodapé sem prop `version`. Passei do build via `VITE_APP_VERSION`."
- **Iteração mínima**: proponha a menor edição que fecha o gate/tarefa; não reforme arquivos inteiros nem refatore fora do escopo.
- **Relatório cita só o que mudou** (arquivos criados/alterados + veredito dos gates); nunca o que não mudou nem o diff que o usuário já vê.
- **Plano e entrega enxutos**: ≤ 10 linhas por seção; tabela curta em vez de parágrafo; próximos passos como lista de comandos.

**Nunca comprima**: código e comandos; mensagens de commit e PR; documentos (`docs/`, `entrega.md`, specs); textos de UI e mensagens de erro citadas; avisos de segurança; confirmação de ação destrutiva ou irreversível; passos em sequência em que fragmento causa dúvida; e quando o usuário pedir explicação detalhada. O entregável de tarefa grande (AGENTS.md §6) mantém os seis itens, em formato enxuto.

Desligar: o usuário diz "modo normal". Religar: "modo conciso".
