---
name: analytics-negocios
description: Base de analytics e monetização para negócios no Fluxo (insights por cidade, parceiro e venue; métricas de perfil, mapa, rota, contato, RSVP e check-in). Use ao tocar em perfis ou fluxos de business, Fluxo Empresas, insights, telemetria, rollups de analytics ou qualquer interação que um parceiro queira medir.
---

# Analytics de negócios

Analytics é parte estratégica do Fluxo. Ao tocar em negócios, deixe base para medir.

## Métricas de referência

- visualizações de perfil de negócio;
- visualizações no mapa;
- cliques em rota;
- cliques em contato;
- cliques em evento vinculado;
- seguidores ganhos;
- RSVP originado por negócio;
- check-ins originados por negócio;
- recortes por cidade, categoria e período.

Entidade alvo: `BusinessAnalyticsSnapshot` (skill `modelo-de-contas`).

## Onde está o código

| Camada | Caminho |
|---|---|
| App | `lib/features/insights/`, `lib/features/fluxo_empresas/` |
| Functions | `functions/src/triggers/analyticsRollupDaily.scheduled.ts`, `functions/src/http/telemetry.routes.ts` |
| Job | `analytics-rollup` (Cloud Run Job via `functions/src/jobs/runner.ts`) |

## Custo

Rollups agendados e contadores têm custo recorrente. Mudança em frequência de cron, retry ou nova consulta `collectionGroup` eleva o eixo de **custo** da matriz de qualidade. Prefira agregação em job diário a contagem em tempo real.
