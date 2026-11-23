# Evidência — EG-JIRA-MANUAL (RB-014)

Gate: abrir um card no Jira pelo espelho e confirmar que o card nasceu certo.
Executado em 2026-11-14 22:26 (-03) por `node scripts/tracker/test-integracao.mjs` (integração REAL no projeto OFLUXO; sandbox com a label `harness-teste`, apagado no fim).

Resultado: # tests 6 # pass 6 # fail 0 
- épico criado com título pela regra, labels, anexo do fluxo e as seções na ordem para pessoas;
- cards criados como filhos do épico, cada um no status do backlog;
- sincronizar de novo não cria issue nem duplica anexo;
- ciclo To Do → In Progress → Blocked → desbloqueio (motivo some) → Done, e Homologation → Done, contra o **workflow direcionado v4** do projeto;
- BRD com e-mail não vai ao épico.

Produção: os backlogs do repositório foram espelhados com o mesmo código (`sync-context.mjs <dir> --all`) e a contagem de cards por status bateu com `backlog.mjs status`.

Limite: o teste aciona o espelho diretamente; ele não passa pela skill `product-owner`.
