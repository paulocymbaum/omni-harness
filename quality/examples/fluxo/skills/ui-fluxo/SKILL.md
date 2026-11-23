---
name: ui-fluxo
description: Identidade visual e diretrizes de UI do Fluxo (neomorfismo, campos côncavos, botões convexos, paleta 2.0 jenipapo, urucum, argila e rio, Fluxo Sans) e catálogo de widgets reutilizáveis. Use ao criar ou alterar telas, widgets Flutter, componentes do admin-web ou do ofluxo_site, temas e cores.
---

# UI do Fluxo

## Identidade visual

- Interface neomórfica.
- Campos côncavos, botões convexos.
- Composição delicada e refinada.
- Paleta da identidade 2.0 (Branding Book, out/2026): jenipapo `#17242B`, urucum `#D2492A` (urucum escuro `#B53D22` para texto pequeno), argila `#EFE7DA`, osso `#F7F3EC`, rio `#1D6E73`. Proporção: argila 55%, jenipapo 30%, urucum 10%.
- Tipografia: Fluxo Sans (derivada do logotipo, peso único, a partir de 18 px) em títulos; Archivo no texto; JetBrains Mono nos rótulos.
- Telas com paleta própria (ex.: Pulso, `CivicPulseVisual`) seguem o brilho do tema do app: nada de `ThemeData.dark()` fixo nem cor `const` de superfície. Defina as duas variantes e escolha por `Theme.of(context).brightness`.
- O logotipo é desenhado: use os arquivos de `fluxo_branding_book/fluxo-kit/01-logos/`, nunca o nome reescrito em fonte. No app, use o widget `FluxoLogo` (SVGs em `assets/brand/`); ele escolhe cor ou negativo pelo tema.

## Reutilize antes de criar

Widgets compartilhados que já existem em `lib/shared/widgets/`:

| Uso | Widget |
|---|---|
| Superfície/card neomórfico | `neo_card.dart`, `fluxo_surface.dart` |
| Campo de texto | `fluxo_text_field.dart` |
| Cabeçalho de subpágina e seção | `fluxo_subpage_header.dart`, `section_title.dart` |
| Diálogo, bottom sheet, toast, loading | `fluxo_dialog.dart`, `fluxo_modal_bottom_sheet.dart`, `fluxo_toast.dart`, `fluxo_loading.dart` |
| App bar e navegação | `fluxo_app_bar.dart`, `liquid_navbar.dart`, `fluxo_drawer.dart` |
| Badge de contagem (não lidos) | `unread_count_builder.dart` (cria o stream uma vez por sessão; nunca assine stream no `build`) |
| Marca (símbolo, logotipo, assinaturas) | `fluxo_logo.dart` (`FluxoLogo`) |

Widgets de domínio existentes: `BusinessCard` e `BusinessCategoryChip` em `lib/features/businesses/presentation/widgets/`.

Temas: `lib/theme/` (`fluxo_brand.dart` com `FluxoColors`, `FluxoRadius` e `FluxoFonts`; `fluxo_bw_color_scheme.dart`; `fluxo_bw_theme.dart` com `fluxoTextTheme()`) e `lib/shared/theme/`.

No app, prefira o papel do `ColorScheme` à cor da marca: no claro, `primary` é urucum escuro e `secondary` é rio; no escuro, urucum claro e rio claro. Use `FluxoColors` direto só para elementos de marca (selo, logo, PDF). As fontes estão empacotadas em `assets/fonts/`, e a família vai em cada `TextStyle` que substitui o estilo do tema (por exemplo `ButtonStyle.textStyle`). A Fluxo Sans tem peso único: não aplique `FontWeight.bold` nela.

Ícones e splash nativos vêm do kit (`flutter_launcher_icons.yaml` e `flutter_native_splash.yaml` na raiz). No Android, o conjunto nativo do kit (`nativo/`) é a fonte oficial, porque o gerador acrescenta 16% de inset ao foreground.

## Componentes alvo (ainda não existem)

`ProfileHeader`, `BusinessBadge`, `CategoryChip` genérico, `AccountKindPill`, `UnifiedMapMarker`, `ContextualCTA`. Ao criar um deles, coloque em `lib/shared/widgets/` se for usado por mais de uma feature, e atualize esta tabela.

## Web

- `admin-web/`: MUI 7 + Emotion.
- `ofluxo_site/`: componentes próprios, `framer-motion`, `three`.
- `packages/creator-render/`: componentes de peça do Creator (paleta em pares, balões, selo de origem) em React puro para Satori. Não duplique no site; consuma o pacote (`file:` + build) e veja o README dele.

No `ofluxo_site/`, os tokens ficam em `src/styles/fluxo-tokens.css`. A landing usa canais RGB (`--ink-rgb`, `--panel-rgb`, `--accent-N-rgb`) definidos em `src/styles/base.css`: tema argila por padrão e `.tema-jenipapo` nas seções escuras. O `/app` usa `--fluxo-*` em `platform.css`, e a marca entra pelo componente `FluxoBrand`.

Mantenha a mesma paleta. Não introduza outra biblioteca de componentes.
