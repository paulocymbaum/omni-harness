---
name: eventos
description: Regras do modelo de evento do Fluxo, com organização multi-entidade (pessoa, business, artista, coletivo), visibilidade, eventos privados, política de endereço, RSVP, match e exibição em mapa/agenda/feed/perfil. Use ao criar ou alterar eventos, RSVP, convites, agenda, importação de eventos de artistas ou qualquer tela ou endpoint que liste eventos.
---

# Eventos

Evento **não** é um objeto isolado de calendário. Ele aparece no mapa, na agenda, no feed e no perfil do organizador.

## Organização multi-entidade

Campos conceituais desejáveis:
- `ownerAccountId`, `ownerAccountKind`
- `hostBusinessId?`, `hostArtistId?`, `linkedCollectiveId?`
- `visibility`, `allowedAccountIds`
- `category`, `tags`, `geo`
- `ticketingConfig`, `paymentConfig`
- `addressVisibilityPolicy`
- `liveStatus`

`ownerAccountKind` usa o `AccountKind` canônico (skill `modelo-de-contas`).

## Regras essenciais

- Eventos privados continuam protegidos: conteúdo só para convidados (`allowedUids`/`allowedAccountIds`) e fora do mapa e das sugestões.
- O endereço respeita a política de liberação.
- RSVP `going` continua sendo a referência principal de presença confirmada.
- Match de evento continua condicionado a presença e settings.
- Não apague lógica de agenda/feed/mapa para "simplificar".

## Onde está o código

| Camada | Caminho |
|---|---|
| App | `lib/features/events/`, `lib/features/agenda/`, `lib/features/artists/` |
| API | `backend/src/Fluxo.Api/Modules/Events/`, `Modules/Artists/`, `Infrastructure/EventProviders/` |
| Functions | `functions/src/triggers/` (sync de artistas, lembretes), `functions/src/http/artistsEvents.routes.ts` |
| Flags | `USE_API_EVENT_READ`, `USE_API_EVENT_WRITE`, `USE_API_EVENTS_LIST_READ`, `USE_API_ARTIST_EVENTS` |

## Docs relacionados

- `docs/eventos/`
- `docs/artistas/artist_events_aggregation.md`
- `docs/event_economy.md`
