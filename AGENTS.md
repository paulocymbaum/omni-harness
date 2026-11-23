# AGENTS.md — omni-harness

Orientação núcleo para agentes de código que trabalham em um hospedeiro gerenciado pelo **omni-harness**. Só o essencial que vale para **toda** tarefa mora aqui; o conhecimento de domínio fica no **perfil do hospedeiro** (`quality/profile/`, campo `prompt.overlay`) e nos módulos indicados no §7.

O motor de qualidade é determinístico e o mesmo em qualquer IDE/agente: `node quality/run.mjs`. As regras vivem em gates testáveis (`quality/gates/`), não em opinião. Contexto do workflow completo: `docs/harness/INDEX.md`.

## 1. Princípios

1. Motor de qualidade antes de opinião: se um gate reprova, conserte a causa — nunca contorne com supressões (`biome-ignore`, `eslint-disable`, `--no-verify`).
2. Conhecimento de domínio no perfil (`quality/profile/prompt.md`), não espalhado em código.
3. Mudanças incrementais: preservar comportamento existente, documentar o que alterar.
4. Tipagem forte, organização por domínio, baixo acoplamento, legibilidade.
5. Centralize regras e enums; evite hardcode espalhado.
6. Nunca exponha dado sensível (CPF/CNPJ, token, credencial) em código, log, card ou commit.
7. Documente decisões arquiteturais no doc do domínio (`docs/`).

## 2. Estado atual

O estado vivo e a missão do produto ficam no perfil do hospedeiro: leia `quality/profile/prompt.md` (campo `prompt.overlay` do `profile.json`) no começo da sessão. O inventário de arquivos instalados: `HARNESS-MANIFEST.txt`.

## 3. Restrições

Não faça sem justificativa formal registrada (commit ou doc):

- apagar gates existentes para "simplificar";
- importar código de `.claude/hooks/` ou `.clinerules/hooks/` dentro de `quality/` (o núcleo nunca depende de hook de host);
- colocar dado pessoal (CPF/CNPJ, uid, e-mail, token) em card, commit, log ou título;
- acoplar o núcleo a uma única ferramenta de mercado (o harness é agnóstico).

## 4. Critérios de qualidade

Toda implementação busca tipagem forte, organização por domínio, baixo acoplamento, componentes reutilizáveis, legibilidade, documentação suficiente e compatibilidade gradual.

A qualidade é medida por gates determinísticos: rode `node quality/run.mjs --tier rapido` a cada edição e `--tier rotina` ao concluir. Nunca afirme que um gate passou se ele não rodou.

## 5. Fluxo de trabalho

1. Leia o perfil do hospedeiro (`quality/profile/prompt.md`) e o índice do workflow (`docs/harness/INDEX.md`).
2. Descubra o código com o grafo quando disponível (`graphify query "<Identificador>"`); leia só o trecho apontado.
3. Implemente a menor mudança que fecha a tarefa; rode `node quality/run.mjs --tier rapido` após editar.
4. Documente: doc do domínio em `docs/`, entrega em `docs/entregas/` quando aplicável.
5. Commit na branch de trabalho correta (nunca direto em `main`/`release`/`develop`).

## 6. Entregável de tarefa grande

Ao final, informe: 1) arquivos criados; 2) arquivos alterados; 3) decisões principais; 4) pendências; 5) riscos; 6) próximos passos.

## 7. Módulos

> Índice completo: `docs/harness/INDEX.md` (um doc por workflow: hooks, gates, ciclo, tracker, release).

- **Qualidade**: `QUALITY.md` e `node quality/run.mjs` — níveis rápido/rotina/completo.
- **Gates**: `quality/gates/` — uma regra testável por arquivo; registry e precedência em `quality/lib/`.
- **Perfil do hospedeiro**: `quality/profile/` — identidade do projeto, ativos e prompt overlay.
- **Hooks por agente**: Claude Code em `.claude/` (settings + hooks), Cline em `.clinerules/hooks/` — sempre ponte para o núcleo `quality/`.
- **Carriers de instruções**: VS Code/Copilot (`.github/copilot-instructions.md`), Antigravity (`.antigravity/rules/`), Kiro (`.kiro/steering/`) — apontam para este arquivo.
- **Docs vivos**: `docs/harness/` — cada workflow com doc próprio.
- **Instalação/saúde**: `bin/omni-harness.mjs` (`doctor`, `hosts`) — diagnostica o hospedeiro.

## 8. North Star

O harness é infraestrutura neutra de qualidade e workflow para agentes de código: o mesmo motor, os mesmos gates e o mesmo contexto de sessão em qualquer IDE ou CLI — e o conhecimento do projeto em um perfil que o time edita sem tocar em código.
