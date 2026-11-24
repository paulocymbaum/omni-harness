# Exemplo SaaS

Exemplo SaaS é uma rede social geolocalizada para ocupar a cidade, descobrir eventos e interagir em tempo real a partir de um mapa vivo. O app combina exploração urbana, comunidades e comunicação para transformar deslocamentos e encontros em experiências compartilhadas.

## Setup rápido
1. Flutter 3.8+ e Dart 3.8+ instalados.
2. Configure Firebase (Auth, Firestore, Storage, Functions) e gere `lib/firebase_options.dart` com o FlutterFire CLI.
3. Token do Mapbox: defina `MAPBOX_TOKEN` (público) via `--dart-define MAPBOX_TOKEN=SEU_TOKEN` **ou** crie um `.env.local` (não comitar) com `MAPBOX_TOKEN=SEU_TOKEN`.
4. Rode `flutter pub get` e depois `flutter run --dart-define MAPBOX_TOKEN=...` (ou já tendo o `.env.local` carregado).

## Funcionalidades principais (por tela)
- **Mapa (início)**: apresenta eventos no entorno com clusters, pins de stories e pontos turísticos; permite buscar endereço/local, abrir detalhes, traçar rotas e selecionar um ponto no mapa para criar evento.
- **Pulso cívico**: mostra eventos e encontros cívicos por recorte territorial (Brasil, UF, município), com pontos estratégicos e bairros no mapa; permite gerar rascunho de evento ou comunidade a partir de um ponto selecionado.
- **Feed**: mostra o feed global com posts de usuários e de eventos, além do bloco de shows de artistas seguidos; permite publicar texto/imagem, vincular evento, curtir, comentar, repostar, mencionar `@` e compartilhar.
- **Post (thread)**: exibe o post completo com contagens, comentários e respostas; permite comentar, mencionar pessoas e acompanhar o histórico.
- **Detalhes do evento**: apresenta capa, descrição, data/horário, local, visibilidade e status de presença; permite confirmar "Vou/Interessado", compartilhar, abrir chat, publicar no feed do evento, ver stories/galeria e acessar check-in.
- **Chat do evento**: mostra a conversa em tempo real e seu status de presença; permite enviar mensagens para quem está no evento.
- **Check-in (host/scan)**: a tela do host exibe um QR dinâmico; a tela de scan lê o QR e registra o check-in do participante.
- **Matches do evento**: apresenta cards de participantes, quem curtiu você e seus matches; permite curtir pessoas e acessar o chat do evento.
- **Agenda**: mostra calendário e listas de confirmados e sugeridos; permite filtrar por raio, amigos e artistas seguidos, além de agendar lembretes.
- **Comunidades e artistas**: páginas de comunidades exibem membros, convites e eventos vinculados; artistas seguidos alimentam a seção de shows no feed.
- **Amigos**: tela de adicionar amigos mostra sugestões por eventos e busca por nome/telefone; permite enviar solicitações e gerenciar amizades.
- **Mensagens diretas**: lista conversas com prévia e não lidas; chat individual para trocar mensagens em tempo real.
- **Notificações**: mostra curtidas, comentários, menções e convites; permite abrir posts e aceitar/rejeitar solicitações.
- **Perfil**: exibe foto, bio, status de identidade, fotos e publicações; permite editar dados, controlar visibilidade e iniciar conversa.
- **Configurações**: organiza privacidade, matches, visibilidade do feed, comentários em fotos, tema e lembretes.
- **Interface neomórfica**: relevo suave com paleta roxo escuro, verde-claro e laranja queimado; tipografia refinada e responsiva.

## Regras de negócio (resumo)
- Eventos privados só são visíveis para criador e `allowedUids`, não aparecem no mapa, agenda pública ou sugestões.
- Posts seguem visibilidade do autor (public/friends/private); o feed global lista apenas `public`.
- Posts vinculados a eventos herdam a visibilidade do evento.
- Repost cria um novo post com `repostOf` apontando para o original; o preview não duplica mídia.
- Menções usam `@` e geram notificação/push (limite de 12 por post/comentário, sem notificar o próprio autor).
- "Vou" cria item confirmado na agenda; "Interessado" permanece salvo sem entrar em confirmados.
- Sugestões de agenda combinam eventos públicos + amigos indo + interesses + recência, com filtros por raio.
- Match só permite curtidas entre participantes e pode ser desativado nas configurações.
- Check-in valida apenas com a chave/QR atual do evento.

## Arquitetura e módulos

Monorepo com oito camadas executáveis (inventário canônico: `quality/config/layers.json`):

| Camada | Pasta | Stack | Doc |
|---|---|---|---|
| App mobile | `lib/` | Flutter, BLoC, go_router, `get_it`, Mapbox | este README |
| Painel admin | `admin-web/` | React + Vite, TanStack Query | `admin-web/README.md` |
| API principal | `backend/` | .NET 10 Minimal API, Cloud SQL PostgreSQL, outbox | `backend/README.md` |
| Backend legado | `functions/` | Firebase Functions (TS) + Cloud Run Jobs | `functions/README.md` |
| Menu Extractor (OCR) | `OCR_webscraper_crawler/` | Hono, Document AI/Gemini, Firestore | `OCR_webscraper_crawler/ARCHITECTURE.md` |
| Debate worker (Debate ao Vivo — **feature arquivada**) | `services/debate-worker/` | Node 22, ffmpeg, Soniox STT, Vitest | `services/debate-worker/README.md` · [arquivamento](docs/entregas/2026-10-21-debate-ao-vivo/ARQUIVADA.md) |
| Dados e regras | `firestore.rules`, `storage.rules`, `backend/deploy/sql/` | Firestore + PostgreSQL | `docs/firestore_schema.md` |
| Infra e CI | `infra/gcp/`, `cloud/monitoring/`, `.github/workflows/` | Terraform, Cloud Build, Cloud Run | `infra/gcp/README.md` |

Também no repo: `ofluxo_site/` (site público, incluindo as páginas de Debate ao Vivo e pulso cívico), `packages/fluxo_presence_bridge` (plugin nativo de presença), `automation/` (ETL offline de dados eleitorais do TSE, Python), `interface_mobile/` (atlas de capturas das telas) e `docs/entregas/` (registro das entregas).

**Migração em andamento.** Firebase continua responsável por Auth, App Check, Analytics, FCM e Storage. Os dados transacionais estão migrando por domínio para a API .NET + PostgreSQL. No app, cada repositório escolhe entre REST (`Exemplo SaaSApiClient`; padrão `https://api.ofluxo.app/api/v1/`, sobrescrito por `--dart-define FLUXO_API_BASE_URL`) e Firestore/callables por flags `USE_API_*`. Hoje usam REST por padrão: messages, route-share, businesses, communities, notifications, events, profile, identity e o cardápio do Exemplo SaaS Empresas. Feed, amizades, stories, presença, pagamentos, iFood/places e moderação continuam em Firestore/Functions. Estado e flags: `docs/migration/MIGRATION_STATUS_2026-08-25.md` e `docs/migration/REST_AND_JOBS_ROLLOUT_2026-09-19.md`.

### App Flutter (`lib/`)

- `core/` — cliente HTTP da API, ambiente, flags de identidade, push, crash reporting.
- `navigation/app_router.dart` — rotas (go_router).
- `service_locator.dart` — registro `get_it` de repositórios, commands e cubits.
- `shared/` — storage, mídia, localização, tema, widgets.
- `features/<feature>/{data,domain,presentation}` — 32 features. Principais:
  - `map`, `events`, `feed`, `agenda`, `friends`, `messages`, `chat`, `notifications`, `profile`, `settings` — núcleo social e de eventos.
  - `civic` — pulso cívico: recortes territoriais (BR/UF/município), pontos estratégicos, bairros e encontros cívicos.
  - `communities`, `tribes`, `artists` — comunidades e artistas seguidos.
  - `identity`, `account_context`, `presence_integrity` — identidade federada, contexto pessoa/empresa e copresença.
  - `businesses`, `business_accounts`, `fluxo_empresas`, `insights` — contas empresariais, cardápio e métricas.
  - `ifood_catalog`, `ifood_merchant`, `places` — integração iFood e lugares.
  - `route_share`, `share_route`, `itinerary` — rotas compartilhadas e roteiros.
  - `user_coordinated_payments` — pagamentos PIX coordenados.
  - `moderation`, `interactions`, `auth`, `home`.

## Privacidade e segurança
- Eventos privados exibem conteúdo apenas a convidados (`allowedUids`) e não entram no mapa/sugestões.
- Posts e fotos respeitam visibilidade (public/friends/private) e permissões de comentários do usuário.
- Regras do Firestore reforçam autoria, contadores controlados por Functions e escopos de leitura.
- Tokens do Mapbox e Firebase ficam fora do repositório (usa `--dart-define` e configs locais).

## Extração de cardápios (OCR + scraper)

A camada Menu Extractor vive em `OCR_webscraper_crawler/` (packages `@menu-extractor/*` + apps `router`, `ocr-worker`, `scrape-worker`, `structurer`). A UI de testes `apps/local-dev` **não** entra neste monorepo. Guia: `OCR_webscraper_crawler/INTEGRAR_EM_MONOREPO.md`.

```bash
pnpm ocr:install
cp OCR_webscraper_crawler/.env.example OCR_webscraper_crawler/.env
pnpm ocr:build
pnpm ocr:test
```

As Cloud Functions chamam `POST /v1/extract` via `MENU_EXTRACTOR_BASE_URL` / `MENU_EXTRACTOR_API_KEY` (`functions/.env.example`). Deploy GCP: `OCR_webscraper_crawler/deploy/`.

## Documentação técnica
- API .NET: `backend/README.md`
- Functions e jobs: `functions/README.md`
- Painel admin: `admin-web/README.md`
- Menu Extractor: `OCR_webscraper_crawler/ARCHITECTURE.md`, `OCR_webscraper_crawler/deploy/README.md`
- Worker de debates: `services/debate-worker/README.md`
- Documentação completa do produto: `docs/FLUXO_DOCUMENTACAO_COMPLETA.md`
- Atlas visual das telas: `interface_mobile/README.md`
- Gates de qualidade: `QUALITY.md`
- Infra GCP: `infra/gcp/README.md`
- Migração Firebase → GCP: `docs/migration/`
- Schema Firestore: `docs/firestore_schema.md`

## Como rodar e testar
```bash
flutter pub get
flutter run --dart-define MAPBOX_TOKEN=SEU_TOKEN
# opcional: --dart-define FLUXO_API_BASE_URL=... (padrão api.ofluxo.app)
# testes
flutter test
```

## Identidade federada

- Guia técnico: `docs/IDENTITY_FEDERADA_CPF_CNPJ.md`
- Rollout e flags: `docs/ROLLOUT_IDENTITY_FLAGS.md`
- Validação completa da feature:

```bash
./scripts/test_identity_federation.sh
```

## Roadmap curto
- Consolidar DI: instanciar cubits específicos (event/threads) somente nas rotas que recebem parâmetros.
- Otimizar consultas pesadas da agenda/amigos com agregações e denormalização de metadados.
- Adicionar testes de unidade para comandos (auth, feed, eventos) e integração com emuladores Firebase.
- Expandir documentação de deploy (Android/iOS/Web) e caminhos para CI/CD.
