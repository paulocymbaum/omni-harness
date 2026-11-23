# Evidência — EG-CICLO (RB-012)

Gate: executar o ciclo (planejamento → implementação → gates → mark done) e confirmar que o fluxo completo funciona.
Executado em 2026-11-14 22:26 (-03) por `node --test quality/test/delivery/ciclo.integration.test.mjs` (CLI real, backlog temporário).

O teste percorre: `init` (com rascunhos de BRD e fluxo) → tarefas e gates → `validate` → `next` → `mark in_progress` (congela os gates) → `done` → `blocked` sem motivo recusado e com motivo aceito → `next` sai 3 (travada) → desbloqueio apaga o motivo → `done` da última tarefa recusa a homologação com BRD/fluxo em rascunho (o done fica gravado) → BRD e fluxo `ready` → `homologar` gera `homologacao.md` → `--aprovar` → `next` informa entrega concluída.

Resultado (ciclo + controles + homologação + mark): # tests 33 # pass 33 # fail 0 
Controles cobertos em `harness-controles.test.mjs`: timeout por gate, congelamento de gates (`--correcao`), hook `guarda-backlog`.

Limite: é a execução automatizada pela CLI. Uma entrega real conduzida por agentes (investigador, implementador) não é reproduzida pelo teste.
