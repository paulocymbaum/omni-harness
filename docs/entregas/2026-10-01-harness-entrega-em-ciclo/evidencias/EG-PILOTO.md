# Evidência — EG-PILOTO (RB-015)

Gate: executar a entrega piloto de ponta a ponta com o harness e confirmar que os artefatos foram criados.
Executado em 2026-11-14 22:26 (-03): piloto automatizado em `quality/test/delivery/ciclo.integration.test.mjs` (mesma execução de EG-CICLO) e uso real do harness nesta sessão sobre os backlogs do repositório.

Artefatos que o piloto cria e confere: `backlog.json` com bloco `homologacao`, `brd.md` e `fluxo-usuario.md` (rascunhos do `init`), tarefas e gates, `gates_sha`, `homologacao.md`; estado final `aprovada`.
Uso real: 10 épicos e 115 cards espelhados no Jira com BRD e fluxo em rascunho; homologação do Creator definida no backlog; guarda de status e congelamento de gates ativos.

Resultado: # tests 33 # pass 33 # fail 0 

Limite: não houve uma feature nova inteira entregue só para este piloto. A prova é o teste automatizado e o uso real descritos acima.
