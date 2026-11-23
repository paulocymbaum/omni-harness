# PROJETO — overlay do Fluxo (R2 do harness agnóstico)

<!-- FONTE VIVA do produto para este host. O perfil (quality/profile/fluxo.json, prompt.overlay)
     aponta para cá; sync-clinerules espelha para .clinerules/85-projeto.md. O AGENTS.md mantém um
     resumo das seções §1/§3/§4/§8 com ponteiro para cá. Não coloque dado sensível (CPF/CNPJ, uid). -->

## 1. Missão do produto

Fluxo é uma plataforma social geolocalizada que usa o mapa como interface principal para descoberta e interação entre:
- pessoas;
- eventos;
- negócios locais;
- artistas;
- comunidades, tribos e coletivos;
- rotas, viagens e deslocamentos.

O produto tem quatro pilares: interação social contextual (feed, chat, stories, agenda, RSVP, match), confiança, identidade e antifraude. **Não é um app de eventos.** É uma infraestrutura social, urbana e econômica.

## 3. Estado atual

Já existem, em algum nível, os domínios abaixo. Respeite-os, refatore com cuidado e documente o que alterar:
- autenticação e onboarding;
- mapa e descoberta;
- eventos;
- agenda;
- feed;
- notificações;
- mensagens e chats;
- amigos, comunidades, artistas e tribos;
- match;
- perfil e mídia;
- configurações;
- identidade, prova humana e copresença;
- rotas e caronas;
- roteiros e viagens;
- debate ao vivo e checagem de fatos (**arquivada** — docs/entregas/2026-10-21-debate-ao-vivo/ARQUIVADA.md; código permanece, sem desenvolvimento ativo);
- pulso cívico e recortes territoriais (civic);
- dados eleitorais e ETL (TSE);
- insights administrativos.

A arquitetura (pastas, stacks e migração Firebase → API .NET) está em README.md.

## 4. Restrições

Não faça sem justificativa formal:
- colapsar business, artista e coletivo no mesmo tipo raso;
- tratar evento apenas como objeto isolado de calendário;
- apagar lógica existente de agenda, feed ou mapa para "simplificar";
- substituir identidade/verificação por um booleano simplista sem camada de modelo;
- expor documento legal em perfil público;
- transformar o mapa em simples listagem;
- ignorar regras de visibilidade já existentes.

## 8. North Star

> O Fluxo é uma infraestrutura social geolocalizada, urbana, ética e escalável, que conecta pessoas, eventos, negócios, artistas e comunidades por meio do mapa, com contexto local, confiança e potencial econômico real.
