---
name: revisar-entrega
description: Revisão técnica ao final do loop de backlog. Roda todos os eval-gates de cada tarefa do backlog, a checagem de integridade anti-force-pass e os gates de qualidade do diff, e consolida um relatório de código com o status de cada gate. Use depois que todas as tarefas estiverem done e antes de documentar e fechar a entrega (entre a Fase D e a Fase F do ciclo entrega-em-ciclo).
allowed-tools: Bash(node quality/delivery/eval.mjs *), Bash(node quality/delivery/integridade.mjs *), Bash(node quality/delivery/validate-testes.mjs *), Bash(node quality/delivery/backlog.mjs *), Bash(node quality/run.mjs *), Bash(git diff *), Bash(git log *), Read, Grep, Glob
---

# Revisar entrega — relatório de gates ao final do loop

Execute esta skill depois que todas as tarefas do backlog estiverem com `status: done` e antes de documentar (`documentar-entrega`) ou fechar a entrega. Ela produz o **Relatório de Revisão de Entrega**, que vai para o `entrega.md` e para o card Jira.

---

## Passo a passo

### 1. Verificar estado do backlog

```bash
node quality/delivery/backlog.mjs status docs/entregas/<slug>
```

Se qualquer tarefa não estiver `done`, não prossiga. Marque como blocked e registre o motivo.

### 2. Checagem de integridade (anti-force-pass)

```bash
node quality/delivery/integridade.mjs docs/entregas/<slug>
```

- `severity: error` → bloqueante; não gere o relatório até resolver.
- `severity: warn` → registre no relatório e explique por que não é crítico.

### 3. Validar estrutura dos gate tests

```bash
node quality/delivery/validate-testes.mjs quality/test/delivery/*.test.mjs
```

Padrões proibidos: `assert.ok(true)`, bloco vazio, `test.skip` incondicional. Qualquer reprovação é bloqueante.

### 4. Rodar eval-gates de cada tarefa

Para cada tarefa do backlog (leia o `backlog.json` para obter os IDs):

```bash
node quality/delivery/eval.mjs docs/entregas/<slug> <ID>
```

Repita para todos os IDs. Consolide:
- Gate **passou** (código 0): ✅
- Gate **falhou** (código ≠ 0): ❌ — copie a primeira linha do stderr
- Gate **manual** (type: manual): 🔲 — exige evidência anotada manualmente

### 5. Avaliar qualidade do diff

```bash
node quality/run.mjs --risk
```

Escolha o nível pelo risco (ver skill `avaliar-qualidade`):

| Risco | Nível | Comando |
|---|---|---|
| baixo / médio | rotina | `node quality/run.mjs --tier rotina` |
| alto / crítico | completo | `node quality/run.mjs --tier completo` |

Copie a saída integralmente para o relatório.

### 6. Resumo do diff

```bash
git diff main...HEAD --stat
git log main...HEAD --oneline
```

Liste os arquivos alterados por domínio (Flutter, Functions, .NET, docs).

---

## Formato do relatório

```markdown
# Relatório de Revisão de Entrega — <slug>

**Data:** <AAAA-MM-DD>
**Branch:** <nome>
**Tarefas:** <lista de IDs>

---

## 1. Integridade do backlog

<saída do integridade.mjs — OK ou lista de achados>

---

## 2. Gate tests — estrutura

<saída do validate-testes.mjs — OK ou erros>

---

## 3. Eval-gates por tarefa

| Tarefa | Gate | Resultado | Observação |
|---|---|---|---|
| <ID> | <gate-id> | ✅ / ❌ / 🔲 | <mensagem de erro ou evidência manual> |

**Resumo:** <N> tarefas, <N> gates, <N> aprovados, <N> falharam, <N> manuais pendentes.

---

## 4. Qualidade do diff

<saída completa de node quality/run.mjs --tier <nível>>

---

## 5. Arquivos alterados

<saída de git diff main...HEAD --stat>

---

## 6. Veredito

- [ ] Integridade: OK / bloqueante
- [ ] Gate tests: OK / bloqueante
- [ ] Eval-gates: todos ✅ / ❌ (<N> falharam)
- [ ] Gates manuais: todos com evidência / <N> pendentes
- [ ] Qualidade: APROVADO / REPROVADO (<lista de gates>)

**Conclusão:** PRONTO PARA DOCUMENTAR / REPAROS NECESSÁRIOS / BLOQUEIO EXTERNO
```

---

## Regras invioláveis

- Nunca marque o veredito como PRONTO se houver `error` de integridade, `❌` em eval-gate ou `REPROVADO` em gate de qualidade.
- Gates do tipo `manual` exigem evidência explícita (screenshot, log, saída colada). Sem evidência = pendente.
- Não altere `backlog.json`, gate tests ou configuração de qualidade para fazer gates passarem.
- Não afirme que um gate passou se ele não rodou.
- Se `node quality/delivery/eval.mjs` retornar `tarefa não encontrada`, investigue antes de prosseguir.
