---
name: modelo-de-contas
description: Modelo conceitual de contas do Fluxo (pessoa, business, artista, coletivo), tipos e categorias de negócio, visibilidade e entidades de domínio (BasePublicProfile, PersonProfile, BusinessProfile, ArtistProfile, CollectiveProfile). Use ao criar ou alterar perfis, contas, contexto pessoa/empresa, enums de domínio (AccountKind, BusinessType, BusinessCategory, Visibility) ou qualquer model que represente quem é dono de algo no app, na API .NET ou nas Functions.
---

# Modelo de contas e entidades

## Regra central

Pessoa física, entidade de negócio, artista/criador e coletivo/comunidade/tribo **não são equivalentes**. Não colapse esses conceitos num modelo único sem justificativa formal.

- Artista não é automaticamente business.
- Coletivo não é business.
- Uma pessoa pode ser responsável por um business.
- Um evento pode pertencer a pessoa, business, artista ou coletivo.
- Tipo de conta não substitui categoria de negócio.
- Perfis públicos devem ser extensíveis.

Identidade legal (CPF/CNPJ) é tratada na skill `identidade-e-privacidade`.

## Enums conceituais

```ts
export type AccountKind = 'person' | 'business' | 'artist' | 'collective';

export type VerificationDocumentKind = 'cpf' | 'cnpj';

export type BusinessType =
  | 'EVENT_ORGANIZER' | 'VENUE' | 'SELLER' | 'SERVICE_PROVIDER'
  | 'BRAND' | 'FOOD_PLACE' | 'DIGITAL_CREATOR';

export type BusinessCategory =
  | 'PARTY' | 'FESTIVAL' | 'SHOW' | 'RAVE'
  | 'CLOTHING' | 'LINGERIE' | 'STREETWEAR'
  | 'TATTOO' | 'BARBER' | 'BEAUTY'
  | 'RESTAURANT' | 'BAR' | 'FOOD_TRUCK'
  | 'ART' | 'MUSIC' | 'CINEMA' | 'OTHER';

export type Visibility = 'public' | 'private' | 'followers' | 'invite_only';
```

## Onde os enums já vivem (reutilize, não redefina)

| Stack | Arquivo | Contém |
|---|---|---|
| Flutter | `lib/features/businesses/domain/model/business_profile_model.dart` | `BusinessType`, `BusinessCategory` |
| Flutter | `lib/features/account_context/domain/model/account_context_model.dart` | `activeAccountKind` (string) |
| Flutter | `lib/features/events/domain/model/event_type.dart` | `EventType` (inclui `manifestation`) |
| Functions | `functions/src/identity/shared/types.ts` | `AccountKind`, `FluxoBusinessType` |
| Functions | `functions/src/features/businesses.ts` | aliases locais de `BusinessType`/`BusinessCategory` |
| Site | `ofluxo_site/src/platform/application/platform-store.ts` | `AccountKind` **reduzido** a `'person' \| 'business'` (divergência conhecida) |
| Site | `ofluxo_site/src/platform/domain/business-workspace.ts` | `BusinessType` e a regra de abas por tipo, espelho de `lib/features/fluxo_empresas/domain/business_workspace.dart`, provado pelo gate `BIL-017-PARIDADE-WORKSPACE` |
| API .NET | `backend/src/Fluxo.Api/Modules/Billing/Domain/BillingEnums.cs` | Enums de cobrança (`BillingSubscriptionStatus`, `BillingRail` e demais); sujeito usa `AccountKind` |

Antes de criar um enum novo, procure a definição existente na stack. Se a stack ainda não tiver, crie **um** arquivo canônico na camada `domain` e registre-o nesta tabela. O hook `regras-de-dominio` avisa quando um desses enums é redefinido fora dos arquivos acima.

## Entidades alvo

Convergir, sempre que possível, para: `BasePublicProfile`, `PersonProfile`, `BusinessProfile`, `ArtistProfile`, `CollectiveProfile`, `Event`, `Post`, `Story`, `Route`, `Trip`, `IdentityVerification`, `BusinessAnalyticsSnapshot`.

**BasePublicProfile:** `id`, `accountKind`, `displayName`, `slug`, `bio`, `avatarUrl`, `coverUrl`, `location`, `tags`, `verified`, `createdAt`, `updatedAt`.

**PersonProfile:** `fullName`, `socialName`, `birthDate`, `cpfHash`, `phone`, `interests`, `trustLevel`, `linkedAccounts`, `defaultFeedVisibility`, `matchEnabled`.

**BusinessProfile:** `legalName`, `tradeName`, `cnpjHash`, `responsibleUserIds`, `businessType`, `businessCategory`, `description`, `contact`, `openingHours`, `address`, `geo`, `servicesOffered`, `productsSummary`, `eventCapabilities`, `verified`, `analyticsEnabled`.

Os campos são sugestões de direção. Ao adicionar um campo, verifique primeiro o model existente e o contrato REST correspondente (skill `contratos-backend`).

## Docs relacionados

- `docs/ACCOUNT_CONTEXT_AND_BUSINESS_OWNERSHIP.md`
- `docs/empresas/FLUXO_EMPRESAS.md`
- `docs/CNAE_MAPPING.md`
