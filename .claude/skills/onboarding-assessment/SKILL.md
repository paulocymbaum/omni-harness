---
name: onboarding-assessment
description: >-
  Roda logo após a instalação do harness (harness-init) ou quando o perfil divergir do projeto:
  lê o repositório (recon objetivo), entrevista o dono em blocos, pede os documentos mínimos do
  produto e gera quality/onboarding/PLANO-ADAPTACAO.md — o plano faseado para adaptar o harness
  ao projeto (perfil, camadas, runners, fronteiras como gates, skills de domínio, tracker,
  gitflow). Nada é executado sem o dono aprovar o plano. Use na primeira sessão pós-instalação,
  em re-init do harness, ou quando o dono pedir o assessment.
---

# Onboarding assessment — adaptar o harness ao projeto

> **Contrato:** entrada = repositório hospedeiro + respostas do dono + documentos que ele tiver.
> Saída = `quality/onboarding/RESUMO-RECON.md` (evidências) e `quality/onboarding/PLANO-ADAPTACAO.md`
> (plano faseado, aprovado pelo dono). A skill NÃO edita perfil nem código sem o plano aprovado.

## Fase 0 — Descobrir onde você está

1. Rode `omni-harness doctor` (ou `node bin/omni-harness.mjs doctor`) e leia o perfil ativo:
   `quality/profile/*.json` (stub pós-init = `packs:['pii-br']`, `tracker:'none'`, sem camadas).
2. Marca de "onboarding já feito": existe `quality/onboarding/PLANO-ADAPTACAO.md` com status
   `APROVADO`? Se sim e o dono só quer reavaliar, siga direto para a Fase 4 revisando o plano antigo.
3. Se o repo não tem o harness instalado, pare: rode `harness-init` primeiro (nunca onboarding
   sem motor).

## Fase 1 — Recon do repositório (leia TUDO antes de perguntar qualquer coisa)

Objetivo: o dono nunca deve responder algo que o repo já responde. Levante, com evidências
(caminho de arquivo, e linha quando fizer diferença):

1. **Stacks e toolchains** — manifesto por pasta: `package.json`/`pnpm-workspace` (e `workspaces`),
   `pubspec.yaml`, `*.csproj`/`*.sln`, `go.mod`, `Cargo.toml`, `pom.xml`/`build.gradle*` (+wrappers
   `mvnw`/`gradlew`), `pyproject.toml`/`uv.lock`, `CMakeLists.txt`/`Makefile`, `firebase.json`.
   Lockfiles = dependência pinada; wrappers = não exigir binário global.
2. **Monorepo ou não** — workspaces/melos/subpastas com manifesto próprio; entrypoints de cada app.
3. **Qualidade existente** — framework de testes por stack (jest/vitest/go test/xunit/junit/gtest…),
   linter/formatador configurado (biome/eslint/prettier/clang-format/gofmt), CI existente
   (`.github/workflows/*` — o que ele já valida hoje vira referência de gate).
4. **Arquitetura observable** — pastas de alto nível e o que parece conter (domínio, dados, UI,
   infra, scripts), padrões de nome (features/domain/data/presentation?), schemas (`schema.prisma`,
   `*.gql`, migrations), contratos (`openapi*`, `*.proto`).
5. **Sinais de risco** — arquivos grandes (>500 linhas), secrets no histórico/presentes (sem
   imprimir valores), binários trackados, `node_modules`/`build` trackados, TODO/FIXME densos.
6. **Sanidade de execução** — 1 comando de teste por stack detectada, com timeout curto e
   fail-open (`tool.missing`/erro = registrar "não executável agora", nunca bloquear o onboarding).

Escreva o resultado em `quality/onboarding/RESUMO-RECON.md` (tabelas: stack → evidência → comando
canônico detectado; riscos; perguntas que o recon RESPONDEU sozinho). Este arquivo é anexo do plano.

## Fase 2 — Entrevista (blocos de até 5 perguntas, sempre partindo do recon)

Apresente cada bloco com "detectei X — confirme ou corrija". Pergunta que o recon já respondeu
não se repete. Dono sem resposta = registrar `"a definir"` no plano com a recomendação default
do harness — a entrevista nunca trava.

1. **Produto e criticidade** — o que o sistema faz, quem usa, o que acontece se cair
   (nível de criticidade → matriz de risco), dados sensíveis (PII/financeiro/saúde? LGPD?),
   o que é segredo inegociável.
2. **Arquitetura desejada** — camadas reais do projeto (nomes que o time usa), onde MORAM as
   regras de negócio vs infra/UI, fronteiras proibidas ("UI não fala com banco"),
   direção de dependência; monólito/serviços; o que já é dívida conhecida.
3. **Qualidade** — o que deve REPROVAR vs avisar: tamanho de arquivo/função, complexidade,
   formatação, tipos, testes obrigatórios, cobertura mínima, ratchet (piora reprova) ou teto fixo;
   o que hoje bloqueia merge no CI antigo.
4. **Comandos canônicos** — por stack: build, test (todos e relacionados), lint, format, e
   variáveis de ambiente/segredos necessários (nomes apenas, nunca valores).
5. **Custo e infraestrutura** — recursos com custo contínuo (jobs agendados, min-instances, APIs
   pagas por chamada), tabela de preços se existir, teto mensal aceitável.
6. **Fluxo de trabalho** — tracker (Jira com credenciais `JIRA_*` / none), branches permanentes e
   matriz (gitflow, trunk+release?), homologação (existe ambiente? como aprova?), release
   (versionamento semântico? changelog?).
7. **Domínio e documentação** — áreas que pedem skill de domínio (contratos, UI, database,
   compliance…), glossário de termos, o que o agente NUNCA pode mexer sem aprovação humana.

## Fase 3 — Documentos (mínima viável; ausência vira rascunho)

Peça os documentos nesta ordem, salvando o que vier em `quality/onboarding/documentos/`:

1. Visão do produto / README atual (se não existir, o recon + Fase 2 geram rascunho).
2. Arquitetura atual (diagrama serve; imagem vira anexo referenciado).
3. Glossário/enum de negócio (terms que NÃO podem ser renomeados pelo agente).
4. Política de dados (PII/LGPD/compliance) — alimenta o pack e as `publicLayers`.
5. Contratos de API (OpenAPI/protos) — alimenta boundaries e skills de contratos.
6. Definição de pronto / critérios de qualidade do time.
7. (Opcional) inventário de infraestrutura e custos — alimenta a matriz de custo.

Regra: **documento ausente ≠ bloqueio.** Gere rascunho a partir das respostas, marque
`[RASCUNHO — validar com o dono]` e liste na seção "Documentos pendentes" do plano.

## Fase 4 — O plano de adaptação (`quality/onboarding/PLANO-ADAPTACAO.md`)

Estrutura obrigatória:

```markdown
# Plano de adaptação do harness — <projeto>
- Status: RASCUNHO | APROVADO (dono, data)
- Fontes: RESUMO-RECON.md + entrevista (data) + documentos/

## 1. Retrato atual (do recon, 10 linhas no máximo)
## 2. Perfil alvo (DIFF do stub)
- camadas: [{ id, nome, globs }] — globs REAIS do repo (do recon)
- runners por stack: { root, solution/testFilter/comandos, env }
- boundaries que viram GATE: [{ rule, applies, bad[], internalBad[] }]
- riskMatrix: níveis por tipo de quebra/custo
- enums canônicos; thresholds (tamanos, complexidade, cobertura)
- tracker/gitflow/homologação conforme Fase 2.6
## 3. Gates: o que reprova, o que avisa, o que fica para depois (com motivo)
## 4. Skills de domínio a criar (uma seção por skill: nome, gatilho, conteúdo rascunhado)
## 5. Overlay PROJETO.md (rascunho completo)
## 6. Etapas executáveis (ordem; cada etapa = 1 arquivo/1 mudança + gate que a valida)
## 7. Pendências e bloqueios (quem resolve; ex.: credenciais Jira)
## 8. Documentos pendentes (os [RASCUNHO])
```

Regras: cada etapa da seção 6 é pequena (uma sessão aguenta várias); etapas de gate novo
sempre trazem o teste/gate que as valida; nada de path/nome de produto no NÚCLEO — tudo vive
no perfil e nas skills de domínio do hospedeiro.

Apresente o plano ao dono e só siga para a Fase 5 com `Status: APROVADO`.

## Fase 5 — Execução do plano (etapa a etapa, nunca de uma vez)

Para cada etapa aprovada (em ordem): edite o arquivo/artefato → rode `node quality/run.mjs
--tier rapido` (+ teste específico quando existir) → commit na branch de trabalho. Etapas de
perfil terminam com `node --test quality/test/profile.test.mjs`; etapas de skill de domínio,
com o conteúdo revisado pelo dono. Ao consumir o plano: atualize o status para
`CONCLUÍDO (data)` e rode `node quality/run.mjs --tier rotina` + `--relatorio` como foto final.

## Regras de ouro

1. Recon antes de pergunta; pergunta antes de suposição; suposição nunca vira gate.
2. Falha aberta: tool ausente ou comando quebrado = registro no plano, não bloqueio.
3. Nada de dado sensível (valor de segredo, PII real) em assessment, plano ou commit.
4. O dono aprova: (a) o plano, (b) cada skill de domínio, (c) thresholds que REPROVAM.
5. O harness se adapta ao projeto — nunca o contrário.

