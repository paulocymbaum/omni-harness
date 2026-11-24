---
name: mapa-multimodal
description: Regras do mapa do Exemplo SaaS como agregador multimodal de eventos, negócios, artistas, comunidades, stories e rotas, com filtros e distinção visual por entidade. Use ao alterar o mapa (Mapbox), markers, camadas, clusters, filtros de descoberta ou qualquer fonte de dados exibida no mapa.
---

# Mapa multimodal

O mapa é a interface central do Exemplo SaaS. **Nunca** o reduza a uma lista de eventos.

## O que o mapa agrega (progressivamente)

- eventos;
- negócios;
- artistas;
- coletivos, tribos e comunidades;
- stories geolocalizados;
- rotas e destinos contextuais.

## Filtros desejáveis

Eventos, empresas, artistas, tribos/comunidades, categorias específicas, raio, período, amigos e artistas seguidos.

## Regra visual

Cada tipo de entidade é distinguível por ícone, badge, cor, marker ou camada. Um marker novo deve reaproveitar o padrão existente, não criar um estilo isolado.

## Cuidados

- Eventos privados não entram no mapa (skill `eventos`).
- Novo listener em tempo real (`.snapshots()`) no app eleva o risco de **custo** na matriz de qualidade. Prefira consultas paginadas ou por geohash.
- `lib/features/map/presentation/map_page.dart` é um dos maiores arquivos do app (acima de 9 000 linhas). Não aumente esse arquivo: extraia widgets e lógica para `widgets/` e `bloc/`. O gate de tamanho compara com o `HEAD`.

## Onde está o código

| Camada | Caminho |
|---|---|
| App | `lib/features/map/` (`bloc/`, `widgets/`, `map_page.dart`), `lib/features/places/` |
| Site | `ofluxo_site/` (`mapbox-gl`) |
| Docs | `docs/places_mapbox_first_brd.md`, `docs/places_mapbox_first_trd.md`, `docs/MAPBOX_IOS_CONFLICT.md` |
