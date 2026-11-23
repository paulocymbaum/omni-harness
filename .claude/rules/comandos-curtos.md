# Regra de comandos curtos — lotes pequenos em sequência

Aplicada em toda sessão (Claude Code e Cline). O Cline mata a ferramenta e os hooks por tempo (hooks e comandos em ~2 min); comando longo estoura o timeout, perde a saída e deixa o estado pela metade.

## Regra

1. **Nenhum comando deve passar de ~90 s.** Estimou mais que isso? Divida.
2. **Lotes pequenos em sequência**, um por chamada, lendo o resultado antes do próximo. Nunca um glob gigante nem um `&&` encadeando passos pesados.
3. **Testes por arquivo ou por grupo de 3 a 5 arquivos**, não a suíte inteira: `node --test quality/test/autofix.test.mjs`, não `node --test quality/test/*.test.mjs`. Gates de entrega: `node --test quality/test/delivery/<id>.test.mjs`, um por vez (a pasta toda passa de 2 min).
4. **Gates de qualidade com escopo**: `node quality/run.mjs --tier rapido --files a.mjs,b.mjs`; nível `rotina`/`completo` só ao concluir a entrega, e em segundo plano quando o ambiente permitir — com `nohup … > log 2>&1 & disown` (job em background sem nohup morre de HUP quando o terminal fecha, e a saída em buffer se perde; consulte o progresso lendo o log com `Read`, não com shell).
5. **Escopo antes de varrer**: liste os arquivos (`rtk git status`, `graphify query`) e processe em fatias de 10 a 20 arquivos. Operação em massa (formatar, migrar, sincronizar com o Jira) vai em fatias, conferindo a contagem a cada uma (`sync-context.mjs <dir> <ID>` por tarefa, não `--all` de uma vez em backlog grande).
6. **Comando sem fim certo leva `timeout`**: `timeout 60 <cmd>`. Servidores, emuladores e `watch` rodam em segundo plano e você consulta o log; nunca em primeiro plano.
7. **Estourou o tempo?** Não repita o mesmo comando. Reduza o escopo à metade, rode as fatias e relate o que ficou de fora.
8. **Instalação e build pesados** (`npm install`, `flutter build`, `dotnet build`): um por chamada, com saída filtrada (`rtk err <cmd>`), nunca em paralelo com testes.
9. **Timeout recorrente no mesmo comando? Melhore a performance em vez de só dividir.** Duas frentes, na ordem:
   - **Script de teste/verificação lento**: reescreva em Node em vez de shell com `for`/`grep`/`sed` encadeados (um processo só em vez de N chamadas de subprocesso), reduza varreduras e I/O redundante, guarde resultados intermediários em cache (lcov, manifest, estado em `/tmp` com chave de hash) e evite recompilar o que não mudou.
   - **Código testado lento**: procure gargalo real antes de dividir o teste (profile com `--cpu-prof` ou meça por trecho); extraia o caminho pesado para módulo testável em unidade e cubra o resto com teste de integração mais leve.
   - Dividir um script lento em 4 fatias continua lento 4 vezes: performance primeiro, fatiamento depois.
10. **Esperando processo em segundo plano não é para o shell**: enquanto um gate/build roda em fundo (`nohup … & disown`), consulte o progresso **lendo o arquivo de log** (`Read`/`read_files`), não repetindo comandos de shell — 5 chamadas idênticas seguidas fazem o detector de loop do CLI parar a tarefa. O hook anti-loop (`quality/lib/anti-loop.mjs`) varia o comando na 3ª repetição idêntica e avisa na 4ª; se o aviso vier, mude de estratégia em vez de insistir.

Sinais de que o lote está grande demais: glob com `*` em pasta de testes, `--all`, loop `for` sobre dezenas de arquivos, suíte completa "só para ver".
