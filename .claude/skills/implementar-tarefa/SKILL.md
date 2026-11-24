---
name: implementar-tarefa
description: Como implementar uma tarefa do backlog de entrega em ciclo. Cobre os passos de verificar dependências, ler spec, marcar in_progress, implementar, rodar gates e marcar done. Use junto com o agente implementador ou diretamente ao executar uma tarefa.
---

# Implementar uma tarefa

Esta skill detalha os passos para implementar **uma tarefa por vez** do backlog.

## Antes de começar

1. Verifique o estado do backlog:
   ```bash
   node quality/delivery/backlog.mjs status <dir>
   ```
2. Confirme que a tarefa está `pending` e as dependências estão `done`.
3. Leia o spec: `<dir>/specs/<ID>.md` — deve ter `Status: ready`.
4. Se o spec estiver `draft`, chame o agente `investigador-de-spec` primeiro.

## Exemplo SaaS de implementação

### 1. Provar falha (baseline)

Antes de escrever código, rode os gates e documente que eles falham:
```bash
node quality/delivery/eval.mjs <dir> <ID> --baseline
```
Isso confirma que os gates são significativos.

### 2. Marcar in_progress

```bash
node quality/delivery/backlog.mjs mark <dir> <ID> --status in_progress
```
Isso cria `quality/.state/entrega-ativa.json` com o escopo da tarefa.
O hook `guarda-entrega.mjs` começa a monitorar edições fora do escopo.

### 3. Implementar

Siga o "Contrato de implementação" do spec. Apenas os arquivos listados.
Se precisar de arquivos extras, atualize o spec antes de editá-los.

### 4. Verificar gates

```bash
node quality/delivery/eval.mjs <dir> <ID>
```
Corrija falhas antes de prosseguir.

### 5. Marcar done

```bash
node quality/delivery/backlog.mjs mark <dir> <ID> --status done
```
O comando re-executa todos os gates. Só grava `done` se todos passarem.

### 6. Documentar

Use a skill `documentar-entrega` para atualizar `docs/` e criar `entrega.md`.

## Quando algo dá errado

- **Gate falha persistentemente**: investigue o erro, corrija o código, repita o passo 4.
- **Spec incompleto**: atualize o spec e informe o usuário antes de continuar.
- **Bloqueio** (decisão, credencial, autorização, serviço externo ou 3 reparos sem progresso): `--status blocked --motivo "<o que falta> — <quem resolve>"`, **e pergunte ao usuário** o que ele precisa fazer ou decidir; não encerre só com o `blocked` gravado. Depois rode `backlog.mjs next <dir>`: exit 3 significa travada, então pare e liste os bloqueios. Ver `.claude/rules/backlog-e-gates.md`.
- **Desvio necessário de escopo**: atualize o `scope` em `entrega-ativa.json` e documente no spec.

## Não fazer

- Não marque `done` manualmente sem passar pelos gates.
- Não altere o `backlog.json` diretamente — use os comandos CLI.
- Não implemente mais de uma tarefa por vez.
- Não pule a prova de falha (baseline): o gate precisa falhar antes de passar.

## Porta ocupada ao rodar gates

Use a skill `liberar-portas` (`node scripts/dev/liberar-portas.mjs <porta>... --dry-run`) em vez de `pkill` solto.

## Jira sempre em dia

Regra permanente (ver `.claude/rules/backlog-e-gates.md`): tarefa nova ou retitulada → `node scripts/tracker/sync-context.mjs <dir> <ID>`; status → só pelo `backlog.mjs mark`; lote → `sync-context.mjs <dir> --all` e confira que a contagem por status bate com `backlog.mjs status`; antes de encerrar, sincronize e informe o resultado. Nunca coloque uid, e-mail, `businessId`, CPF/CNPJ ou token real em card.
