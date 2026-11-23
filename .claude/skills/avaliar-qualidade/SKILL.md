---
name: avaliar-qualidade
description: Avalia a qualidade do código afetado no monorepo Fluxo com gates determinísticos (tamanho, complexidade ciclomática, fronteiras de arquitetura, supressões, lint, tipos, testes, cobertura do diff) e classifica o risco da alteração em dois eixos, quebra do backend e escala de custo, para escolher o nível de teste rápido, rotina ou completo. Use ao concluir uma tarefa ou entrega, antes de commit, push ou deploy, quando um hook de qualidade reprovar ou bloquear um comando, ou quando o usuário pedir para medir, avaliar ou revisar a qualidade do código. O modo relatório (avaliação completa de todas as camadas) só deve rodar quando o usuário pedir explicitamente.
allowed-tools: Bash(node quality/run.mjs *), Bash(node --test quality/test/*), Bash(git diff *), Bash(git status *), Read, Grep, Glob
---

# Avaliar qualidade do código afetado

Todo resultado sai do motor determinístico `quality/run.mjs`. **Nunca estime risco, complexidade ou cobertura de cabeça**: rode o comando e use a saída. Mensagens, status (`APROVADO`, `REPROVADO`, `ALERTA`, `IGNORADO`) e o relatório final são sempre em **pt-BR**.

## Passo a passo

1. **Classifique o risco** do que mudou (árvore de trabalho contra o HEAD):

   ```bash
   node quality/run.mjs --risk
   ```

   A saída traz o risco em cada eixo, **quebra do backend** e **escala de custo**, com os motivos e o nível de teste exigido. Para push ou deploy, use `--base remote` (compara com upstream/origin/main). Detalhes em [references/matriz-de-risco.md](references/matriz-de-risco.md).

2. **Escolha o nível** pelo momento e pelo risco. Não suba de nível sem motivo.

   | Momento | Nível | Comando |
   |---|---|---|
   | Iterando (cada edição já roda sozinha pelo hook) | rápido | `node quality/run.mjs --tier rapido` |
   | Concluindo uma entrega de risco baixo ou médio | rotina | `node quality/run.mjs --tier rotina` |
   | Risco **alto** ou **crítico**, ou entrega grande | completo | `node quality/run.mjs --tier completo` |

   Rodar o completo em risco baixo ou médio é desperdício, e o motor avisa. O que cada nível executa por stack está em [references/niveis-de-teste.md](references/niveis-de-teste.md).

3. **Corrija cada `REPROVADO`** na causa e rode **o mesmo nível** de novo até não sobrar nenhum:
   - complexidade ou tamanho: extraia funções, widgets ou serviços; não aumente funções legadas;
   - fronteiras: mova o acesso a Firebase/`data` para a camada certa (`domain` só depende de `domain`/`foundation`);
   - lint, tipos ou testes: corrija o código, não o teste, salvo se o teste estiver errado (explique);
   - fallback para Firestore: com `USE_API_*` ativo, a API é a fonte autoritativa; propague o erro.

4. **Custo:** se o eixo de custo for **alto** ou **crítico**, inclua no relatório os deltas calculados (instâncias, execuções/dia, chamadas pagas) e **pare para pedir aprovação humana** antes de commit ou deploy.

5. **Reporte** no formato de [references/formato-do-relatorio.md](references/formato-do-relatorio.md): risco nos dois eixos, nível executado, gates, pendências e veredito.

## Como os hooks usam isso

- **A cada edição** (`PostToolUse`), o nível rápido roda no arquivo editado. Se reprovar, a mensagem chega para você corrigir. Se o risco da sessão subir, você é avisado.
- **Ao encerrar** (`Stop`), roda o nível automático da matriz: rápido para risco baixo ou médio, rotina para alto ou crítico. Se reprovar, o encerramento é bloqueado no máximo 2 vezes por estado; depois o usuário é avisado.
- **Antes de `git commit`, `git push` e deploys** (`PreToolUse`), o hook exige uma evidência aprovada do nível pedido para o **estado atual** do diff. Qualquer edição posterior invalida a evidência. Risco crítico, e deploy de risco alto, pedem confirmação do usuário.

Se um comando for bloqueado, leia o motivo e rode exatamente o nível sugerido. Não tente contornar o hook.

## Autocorreção de gate e teste

Em arquivo de gate ou de teste o hook `post-edit` já autocorrige e checa sintaxe/lint (Biome). Se bloquear, corrija o arquivo e não contorne; antes do commit rode `node quality/run.mjs --fix`. Regras e armadilhas conhecidas: `.claude/rules/autofix-gates.md`.

## Modo relatório (só sob pedido explícito)

```bash
node quality/run.mjs --relatorio                      # todas as camadas (vários minutos)
node quality/run.mjs --relatorio --camadas ocr,rules  # restringe
```

Ele avalia o repositório inteiro, camada por camada, com a stack de cada uma, os limites absolutos da QUALITY.md e um score de 0 a 100. O resultado vai para `quality/reports/relatorio-<data>.md`. Não use esse modo para validar uma alteração: para isso existem os níveis.

## Modo migração (só sob pedido explícito)

```bash
node quality/run.mjs --tier completo --base origin/main --migration-override "RELEASE 1 — merge completo"
node quality/baseline.mjs --check --migration-override              # ratchet global → IGNORADO
```

Para merge completo ou migração completa (ex.: primeiro release que traz uma linha
de desenvolvimento inteira para `main`), todo o código chega como "novo" e os gates
de métrica incremental viram falso positivo estrutural. A flag substitui esses gates
por um resultado IGNORADO com motivo e contagem: tamanho, tamanho-funcao, parametros,
complexidade, halstead, formato, supressoes, fronteiras, fallback-api, lint e
cobertura-diff. Tipos, testes, exports e ferramentas permanecem ativos; a evidência
registra o modo e o motivo. Não use para validar trabalho incremental.

## Regras invioláveis

- Nunca edite `quality/config/*.json`, `quality/messages.pt-BR.json` ou os testes de `quality/test/` para fazer um gate passar.
- Nunca adicione supressão (`// ignore:`, `eslint-disable`, `@ts-ignore`, `#pragma warning disable`, `[ExcludeFromCodeCoverage]`, `# noqa`) sem justificar no relatório.
- `--migration-override` é só para merge/migração completa e nunca isenta a aprovação de custo nem a validação dos gates semânticos (tipos, testes, exports, ferramentas).
- `ALERTA` e `IGNORADO` **não são aprovação**. Diga explicitamente o que não foi medido (ferramenta ausente, delegado ao CI, tempo esgotado).
- Não faça deploy com risco crítico sem confirmação explícita do usuário, mesmo que a allowlist permita o comando.
- Não afirme que um gate passou se ele não rodou.
