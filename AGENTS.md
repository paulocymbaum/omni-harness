# AGENTS.md — Fluxo

Este arquivo orienta agentes de código (Claude Code, Codex e outros) que trabalham no repositório do **Fluxo**. Ele contém só o núcleo que vale para **toda** tarefa. O conhecimento de cada domínio fica em módulos carregados sob demanda (ver [§7](#7-módulos)).

## 1. Missão do produto

> Fonte viva do projeto: [.claude/PROJETO.md](.claude/PROJETO.md) (perfil: `prompt.overlay`). Resumo:

Fluxo é uma plataforma social geolocalizada que usa o mapa como interface principal para descoberta e interação entre:
- pessoas;
- eventos;
- negócios locais;
- artistas;
- comunidades, tribos e coletivos;
- rotas, viagens e deslocamentos.

O produto tem quatro pilares: interação social contextual (feed, chat, stories, agenda, RSVP, match), confiança, identidade e antifraude. **Não é um app de eventos.** É uma infraestrutura social, urbana e econômica.

## 2. Princípios obrigatórios

1. Não reduza o Fluxo a um app de eventos.
2. Preserve compatibilidade com a base já implementada.
3. Prefira mudanças incrementais e extensíveis a soluções rígidas.
4. Evite simplificações destrutivas.
5. Centralize regras de negócio e enums. Evite hardcode espalhado.
6. Documente decisões arquiteturais.
7. Separe identidade legal, identidade pública, papel social e tipo de conta.
8. Nunca exponha CPF/CNPJ bruto em camadas públicas.
9. Não acople blockchain como dependência obrigatória do core.
10. O mapa é um agregador multimodal.
11. Eventos podem ser organizados por pessoa, business, artista ou coletivo.

## 3. Estado atual

> Detalhe vivo por domínio: [.claude/PROJETO.md](.claude/PROJETO.md). Resumo:

Já existem, em algum nível, os domínios abaixo. Respeite-os, refatore com cuidado e documente o que alterar:
- autenticação e onboarding;
- mapa e descoberta;
- eventos;
- agenda;
- feed;
- notificações;
- mensagens e chats;
- amigos, comunidades, artistas e tribos;
- match;
- perfil e mídia;
- configurações;
- identidade, prova humana e copresença;
- rotas e caronas;
- roteiros e viagens;
- debate ao vivo e checagem de fatos (**arquivada** — [docs/entregas/2026-10-21-debate-ao-vivo/ARQUIVADA.md](docs/entregas/2026-10-21-debate-ao-vivo/ARQUIVADA.md); código permanece, sem desenvolvimento ativo);
- pulso cívico e recortes territoriais (civic);
- dados eleitorais e ETL (TSE);
- insights administrativos.

A arquitetura (pastas, stacks e migração Firebase → API .NET) está em [README.md](README.md#arquitetura-e-módulos).

## 4. Restrições

> Lista viva e rationale: [.claude/PROJETO.md](.claude/PROJETO.md). Resumo:

Não faça sem justificativa formal:
- colapsar business, artista e coletivo no mesmo tipo raso;
- tratar evento apenas como objeto isolado de calendário;
- apagar lógica existente de agenda, feed ou mapa para "simplificar";
- substituir identidade/verificação por um booleano simplista sem camada de modelo;
- expor documento legal em perfil público;
- transformar o mapa em simples listagem;
- ignorar regras de visibilidade já existentes.

## 5. Critérios de qualidade

Toda implementação busca tipagem forte, organização por domínio, baixo acoplamento, componentes reutilizáveis, legibilidade, documentação suficiente e compatibilidade gradual.

A qualidade é medida por gates determinísticos, não por opinião: [QUALITY.md](QUALITY.md) e `node quality/run.mjs`. Nunca afirme que um gate passou se ele não rodou.

## 6. Entregável de tarefa grande

Ao final, informe:
1. arquivos criados;
2. arquivos alterados;
3. decisões principais;
4. pendências;
5. riscos;
6. próximos passos.

O formato completo, com o relatório de qualidade e o espelho no Jira, está no módulo `documentar-entrega`.

### Jira sempre em dia (regra permanente)

Toda entrega gerenciada pelo `backlog.json` tem cards no Jira (projeto `OFLUXO`) e eles devem acompanhar cada passo: tarefa nova ou retitulada → `node scripts/tracker/sync-context.mjs <dir> <ID>`; mudança de status → só por `node quality/delivery/backlog.mjs mark ...` (espelha sozinho); mudança em lote → `sync-context.mjs <dir> --all` e conferir a contagem; antes de encerrar → sincronizar e informar. Nunca coloque uid, e-mail, `businessId`, CPF/CNPJ ou token real em card. Detalhes: [.claude/rules/backlog-e-gates.md](.claude/rules/backlog-e-gates.md).

### Economia de tokens (regra permanente)

Vale para qualquer agente (Claude Code, Cline, Codex). Fonte única: [.claude/rules/economia-de-tokens.md](.claude/rules/economia-de-tokens.md); o espelho do Cline é `.clinerules/10-economia-de-tokens.md` (`node quality/agents/sync-clinerules.mjs`).

1. **Buscar com o grafo**: `graphify query "<Identificador>"`, `explain`, `path`, `affected` antes de `Grep`/`Glob`/`rg`/`find`. Consulte por nome exato, não por frase. Depois `Read` com `offset`/`limit`. Grafo ausente: `graphify extract . --code-only` (nunca sem `--code-only`).
2. **Shell com rtk**: prefixe `rtk` nos comandos ruidosos (`rtk git status`, `rtk test <cmd>`, `rtk read <arquivo>`). No Claude Code e no Cline CLI/SDK o hook faz isso; na extensão VS Code do Cline e em outros agentes, você mesmo.
3. **Resposta concisa (caveman)**: sem preâmbulo, elogio ou recap; fragmento basta; termos técnicos exatos. Nunca comprima código, commits, docs, avisos de segurança nem confirmação de ação destrutiva. "modo normal" desliga.

## 7. Módulos

> Documentação operacional completa do harness (hooks, gates, ciclo de entrega, Jira, ponte Cline, release), um doc por workflow: [docs/harness/INDEX.md](docs/harness/INDEX.md).

Os módulos são Markdown comuns. Claude Code os carrega automaticamente pela descrição. Outros agentes devem **ler o arquivo do módulo antes de editar código do tema**.

### Skills (conhecimento de domínio)

| Tema | Leia antes de tocar em | Arquivo |
|---|---|---|
| Tipos de conta e entidades | perfis, contas, business, artista, coletivo, enums de domínio | [.claude/skills/modelo-de-contas/SKILL.md](.claude/skills/modelo-de-contas/SKILL.md) |
| Identidade e privacidade | CPF/CNPJ, verificação, identidade federada, dados sensíveis | [.claude/skills/identidade-e-privacidade/SKILL.md](.claude/skills/identidade-e-privacidade/SKILL.md) |
| Eventos | modelo de evento, visibilidade, RSVP, endereço, match | [.claude/skills/eventos/SKILL.md](.claude/skills/eventos/SKILL.md) |
| Mapa | camadas, markers, filtros do mapa | [.claude/skills/mapa-multimodal/SKILL.md](.claude/skills/mapa-multimodal/SKILL.md) |
| Interface | widgets, telas, componentes web, paleta | [.claude/skills/ui-fluxo/SKILL.md](.claude/skills/ui-fluxo/SKILL.md) |
| Contratos | DTOs, endpoints, flags `USE_API_*`, breaking changes | [.claude/skills/contratos-backend/SKILL.md](.claude/skills/contratos-backend/SKILL.md) |
| Analytics de negócios | métricas, insights, eventos de tracking | [.claude/skills/analytics-negocios/SKILL.md](.claude/skills/analytics-negocios/SKILL.md) |
| Documentação e entrega | encerrar tarefa, `docs/`, `docs/entregas/<AAAA-MM-DD>-<slug>/`, Jira | [.claude/skills/documentar-entrega/SKILL.md](.claude/skills/documentar-entrega/SKILL.md) |
| Qualidade | antes de commit, push ou deploy | [.claude/skills/avaliar-qualidade/SKILL.md](.claude/skills/avaliar-qualidade/SKILL.md) |
| Revisão de entrega | ao final do loop de backlog, depois de todas as tarefas done | [.claude/skills/revisar-entrega/SKILL.md](.claude/skills/revisar-entrega/SKILL.md) |
| Ciclo de entrega | iniciar ou continuar entrega gerenciada pelo `quality/delivery/backlog.mjs` | [.claude/skills/entrega-em-ciclo/SKILL.md](.claude/skills/entrega-em-ciclo/SKILL.md) |
| Implementação de tarefa | executar tarefa do backlog: ler spec, implementar, rodar gates | [.claude/skills/implementar-tarefa/SKILL.md](.claude/skills/implementar-tarefa/SKILL.md) |
| Product owner | triage e priorização do backlog, espelho no Jira | [.claude/skills/product-owner/SKILL.md](.claude/skills/product-owner/SKILL.md) |
| Brainstorm e parking lot | brainstorm de ideias novas, propostas de feature, documentação viva em `docs/parking-lot/` | [.claude/skills/brainstorm-ideias/SKILL.md](.claude/skills/brainstorm-ideias/SKILL.md) |
| Gitflow | branches feat/fix/chore/hotfix/release, branch pai, matriz de merge, push/pull sincronizado, conflitos git, versionamento por camada com bump determinístico | [.claude/skills/gitflow/SKILL.md](.claude/skills/gitflow/SKILL.md) |
| Busca de código | achar onde algo está, entender fluxo, mapear impacto: `graphify query/explain/affected` antes de Grep/Glob/rg/find | [.claude/skills/busca-de-codigo/SKILL.md](.claude/skills/busca-de-codigo/SKILL.md) |
| Modo conciso | respostas curtas estilo caveman, níveis lite/full/ultra, "modo normal" para desligar | [.claude/skills/modo-conciso/SKILL.md](.claude/skills/modo-conciso/SKILL.md) |
| Portas locais | porta ocupada, "address already in use", subir de novo emulador ou serviço local | [.claude/skills/liberar-portas/SKILL.md](.claude/skills/liberar-portas/SKILL.md) |

### Agents (papéis delegáveis)

| Agente | Papel | Arquivo |
|---|---|---|
| `planejador` | Leitura, arquivos impactados, risco e plano. Não edita | [.claude/agents/planejador.md](.claude/agents/planejador.md) |
| `revisor-de-dominio` | Revisa o diff contra este arquivo e as skills. Não edita | [.claude/agents/revisor-de-dominio.md](.claude/agents/revisor-de-dominio.md) |
| `documentador` | Atualiza `docs/` e escreve o `entrega.md` | [.claude/agents/documentador.md](.claude/agents/documentador.md) |
| `investigador-de-spec` | Fase A do ciclo: investiga o código e escreve as specs. Não implementa | [.claude/agents/investigador-de-spec.md](.claude/agents/investigador-de-spec.md) |
| `eval-gate-author` | Fase B do ciclo: escreve os gate tests que provam cada tarefa | [.claude/agents/eval-gate-author.md](.claude/agents/eval-gate-author.md) |
| `implementador` | Fase C do ciclo: implementa a tarefa a partir da spec | [.claude/agents/implementador.md](.claude/agents/implementador.md) |
| `eval-gate-fixer` | Fase D do ciclo: diagnostica e corrige gate falhando | [.claude/agents/eval-gate-fixer.md](.claude/agents/eval-gate-fixer.md) |
| `avaliador-de-entrega` | Fase E do ciclo: roda todos os gates e emite o laudo final | [.claude/agents/avaliador-de-entrega.md](.claude/agents/avaliador-de-entrega.md) |

### Hooks (regras verificadas por máquina)

| Hook | Regra | Arquivo |
|---|---|---|
| A cada edição | CPF/CNPJ literal em código (bloqueia); campo `cpf`/`cnpj` bruto em camada pública, enum de domínio redefinido, dependência de blockchain (avisam) | [.claude/hooks/regras-de-dominio.mjs](.claude/hooks/regras-de-dominio.mjs) |
| Ao encerrar | Arquivo novo de domínio, contrato ou schema sem nenhum `.md` atualizado | [.claude/hooks/lembrar-documentacao.mjs](.claude/hooks/lembrar-documentacao.mjs) |
| Ao trocar de subagente | Valida e grava o bloco HANDOFF em `docs/entregas/<slug>/handoffs/` | [.claude/hooks/handoff-subagente.mjs](.claude/hooks/handoff-subagente.mjs) |
| Sessão e edição | Inventário de sessão e evidência por hash: `session-start`, `post-edit`, `pre-bash`, `stop` (o Stop também **avisa deploy pendente** — homologação aprovada sem `deploy.md` depois dela, QG-027) | [quality/hooks/](quality/hooks/) |
| Autocorreção de gate e teste | Em `post-edit`: normaliza EOL/newline, `dart format`, Biome seguro; sintaxe e lint **novo** voltam ao agente com `arquivo:linha:col` (3 falhas seguidas: relate). `run.mjs --fix` em lote. Regra: [.claude/rules/autofix-gates.md](.claude/rules/autofix-gates.md) | [quality/lib/autofix.mjs](quality/lib/autofix.mjs) |
| Gates de qualidade | Tamanho, complexidade, fronteiras, lint, tipos, testes, risco | [quality/hooks/](quality/hooks/) |
| Comandos git | Gitflow determinístico: criação com branch pai correta, matriz de merge, push sincronizado com origin, conflito para o fluxo com runbook | [quality/hooks/pre-bash-gitflow.mjs](quality/hooks/pre-bash-gitflow.mjs) e [quality/hooks/post-bash-gitflow.mjs](quality/hooks/post-bash-gitflow.mjs) |
| Busca de código | Dica (uma vez a cada 30 min, **sem bloquear**) para consultar o grafo do graphify antes de Grep, Glob `**`, `grep -r`, `rg`, `find -name`; busca em docs e arquivos que não são código é isenta; falha aberta sem grafo ou sem a CLI; `GRAPHIFY_HOOK_MODE=strict` (só Claude Code) nega até haver consulta, `off` desliga. O Cline nunca cancela (cancelar aborta a tarefa) | [quality/hooks/pre-bash-dispatch.mjs](quality/hooks/pre-bash-dispatch.mjs) (Claude Code, despachante único) e [.clinerules/hooks/PreToolUse](.clinerules/hooks/PreToolUse) (Cline) |
| Saída do shell | Reescreve comandos ruidosos para `rtk <cmd>` (sem `rtk` instalado, não faz nada) | [quality/hooks/pre-bash-rtk.mjs](quality/hooks/pre-bash-rtk.mjs) |
| Jira com spec | Ao gravar `docs/entregas/<slug>/specs/<ID>.md`, atualiza o card da tarefa em segundo plano (sem credenciais JIRA_* só avisa; um sync a cada 2 min por tarefa; `FLUXO_JIRA_AUTOSYNC=0` desliga) | [.claude/hooks/sync-spec-jira.mjs](.claude/hooks/sync-spec-jira.mjs) |
| Guarda do ciclo | Integridade do backlog e das fases da entrega | [quality/delivery/guarda-entrega.mjs](quality/delivery/guarda-entrega.mjs) |

Os hooks rodam no Claude Code (registrados em [.claude/settings.json](.claude/settings.json)) e **no Cline** (`.clinerules/hooks/`: `PreToolUse`, `PostToolUse`, `TaskStart`, `TaskResume`, `TaskComplete`), que executam os mesmos scripts por [quality/lib/cline-bridge.mjs](quality/lib/cline-bridge.mjs); mapa e limites em QUALITY.md §9.2. Em outros agentes, as mesmas regras valem e devem ser verificadas manualmente.

## 8. North Star

> Fonte viva: [.claude/PROJETO.md](.claude/PROJETO.md).

> O Fluxo é uma infraestrutura social geolocalizada, urbana, ética e escalável, que conecta pessoas, eventos, negócios, artistas e comunidades por meio do mapa, com contexto local, confiança e potencial econômico real.
