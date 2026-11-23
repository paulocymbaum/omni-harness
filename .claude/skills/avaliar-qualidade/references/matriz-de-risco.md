# Matriz de risco

A classificação é determinística: só usa o caminho do arquivo, as linhas adicionadas ou removidas no diff e o tamanho do diff. O mesmo diff sempre dá o mesmo risco. As regras concretas (globs e padrões) ficam **somente** em `quality/config/risk-matrix.json`, que é a fonte autoritativa. Este documento explica como ler e agir.

## Dois eixos

O risco de cada eixo é o **máximo** entre os arquivos alterados. O risco final é o máximo dos dois eixos.

### Quebra do backend

| Nível | Exemplos de gatilho |
|---|---|
| Crítico | Segurança, idempotência, outbox e tráfego da API .NET; migrations, SQL e migrator; Dockerfiles e pipelines de deploy; `firestore.rules`/`storage.rules`; pagamentos e criptografia; Terraform; **remoção de export** em `functions/src/index.ts`, que apaga a função em produção no próximo deploy |
| Alto | Módulos REST da API (contrato consumido pelo app); `lib/core` (cliente HTTP, flags `USE_API_*`); identidade, presença e admin em Functions; router e fetch SSRF-safe do OCR; índices Firestore |
| Médio | Demais códigos de backend e serviço; `data/` e `domain/` do app; dependências e configuração de build |
| Baixo | UI (`presentation/`), web, só testes, docs |

**Modificadores** sobem o eixo de quebra **um nível**, somados ou não:
- mais de 400 linhas de código alteradas, ou 3 ou mais camadas tocadas (só a partir de médio);
- arquivo de teste removido.

### Escala de custo

| Nível | Exemplos de gatilho |
|---|---|
| Crítico | Instâncias mínimas aumentadas (o delta aparece em instância-hora/mês); agendamento mais frequente (o delta aparece em execuções/dia); CPU, memória ou tier do Cloud SQL alterados |
| Alto | Nova chamada a API paga (Document AI, Gemini/Vertex, Firecrawl, Places, Mapbox, Bandsintown, Ticketmaster, Spotify), contada como aumento líquido de call sites; limites, quotas ou rate limit alterados; retry, backoff ou `ackDeadline` alterados; novo trigger Firestore; `collectionGroup`; política de reprocessamento de cardápio |
| Médio | Novo listener em tempo real no app (`.snapshots()`) |

Reduzir custo (menos instâncias, agendamento menos frequente) não eleva o risco. Mover uma chamada de lugar não conta como chamada nova.

## Risco → comportamento

| Risco | Nível exigido | Stop roda | Stop bloqueia | Commit | Push | Deploy |
|---|---|---|---|---|---|---|
| Baixo | rápido | rápido | nunca | livre | livre | livre (flags de custo pedem confirmação) |
| Médio | rotina | rápido | se reprovar | exige rotina | exige rotina | exige rotina |
| Alto | completo | rotina | se reprovar | exige completo | exige completo | exige completo + confirmação |
| Crítico | completo + humano | rotina | se reprovar ou faltar completo | exige completo + confirmação | exige completo | exige completo + confirmação |

A **evidência** é uma execução aprovada de `run.mjs --tier <nível>` registrada para o hash do estado atual: HEAD, diff e arquivos não rastreados. Qualquer edição posterior muda o hash e invalida a evidência.

Uma execução com `--files` ou `--session` só cobre aqueles arquivos. Por isso, **não libera commit**, que exige o escopo da árvore inteira. Push e deploy exigem a execução com `--base remote`.

## Como agir

- **Custo alto ou crítico:** mostre os deltas ao usuário e peça aprovação antes de commit ou deploy.
- **Quebra crítica:** rode o completo, descreva o impacto no relatório (contrato, dados, segurança) e peça confirmação.
- **Risco que parece errado** (falso positivo ou falso negativo): não altere a matriz para passar. Reporte ao usuário com o arquivo e o motivo exibido.
