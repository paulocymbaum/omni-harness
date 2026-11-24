---
name: brainstorm-ideias
description: Brainstorm de ideias novas com documentação viva no parking lot. A cada sessão de brainstorm, cria ou ATUALIZA um arquivo .md por feature em docs/parking-lot/ (nunca espalha ideias por chats ou docs soltos). Use sempre que o usuário pedir brainstorm, ideias novas, sugestões de funcionalidade ou desenho de feature ainda não priorizada.
model: haiku
---

# Brainstorm de ideias — parking lot (`docs/parking-lot/`)

## Regra principal

Toda sessão de brainstorm de ideias novas termina com a documentação viva atualizada:

1. **Um arquivo por feature:** `docs/parking-lot/<feature>.md` (kebab-case, sem acentos). Ideia nova → criar. Ideia existente → **atualizar o arquivo dela**, nunca criar um segundo nem espalhar a ideia em docs soltos.
2. **Documentação viva:** o arquivo acumula decisões tomadas, opções descartadas (com o porquê), novas informações e o status. Não apague decisões anteriores; registre o porquê de cada mudança.
3. **Status no topo:** `estacionada | em avaliação | aprovada | promovida`, com data da última atualização e origem.

## Estrutura do arquivo

Modelo: [`fluxo-onibus-desenho-funcionalidade.md`](../../../docs/parking-lot/fluxo-onibus-desenho-funcionalidade.md).

**Obrigatório:** cabeçalho (status, data, origem, domínios), o que é e o que **não** é, desenho proposto, decisões abertas.

**Quando houver:** por que está no parking lot, fases ou pilotos, métricas, riscos, referências.

## Regras de conteúdo

- Fontes externas marcadas como **verificadas / parciais / a validar**, com data de acesso.
- Não invente endpoints, números de mercado ou promessas de cobertura.
- Exemplo SaaS de tela ou entre camadas ganha diagrama Mermaid (`.claude/rules/fluxogramas.md`).
- Sem dado sensível (CPF/CNPJ, tokens) em exemplos.

## Promoção

Quando a ideia for `aprovada`, siga a skill `product-owner` (abre a entrega com `backlog.mjs init --feature <slug-do-arquivo>`). Ao virar entrega, o arquivo passa a `promovida` e ganha o link para `docs/entregas/<slug>/`.

Brainstorm não isenta as restrições do repositório (AGENTS.md §2 e §4): aplique as skills de domínio (ex.: `modelo-de-contas`, `eventos`) ao desenhar.
