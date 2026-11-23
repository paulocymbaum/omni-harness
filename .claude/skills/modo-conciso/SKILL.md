---
name: modo-conciso
description: Respostas curtas no estilo "caveman" para gastar menos tokens de saída, sem perder precisão técnica. Use quando o usuário pedir "modo conciso", "fale curto", "caveman", "menos tokens" ou "modo normal" (para desligar), e para escolher o nível (lite, full, ultra). A regra base já vale em toda sessão (economia-de-tokens.md).
allowed-tools: Read
---

# Modo conciso (caveman)

Inspirado no plugin caveman (JuliusBrussee/caveman), reescrito em pt-BR e sem código de terceiros. Só afeta a **resposta de chat**. Pensamento, código, commits e documentos seguem normais.

## Níveis

| Nível | Quando | Como |
|---|---|---|
| `lite` | Padrão de revisão e explicação | Frases completas e enxutas. Sem preâmbulo, elogio, recap ou hedging |
| `full` (padrão) | Trabalho diário | Fragmentos. `[coisa] [ação] [motivo]. [próximo passo].` Sem artigos e conectivos de enchimento |
| `ultra` | Só se o usuário pedir | Abreviações comuns (cfg, dep, impl, ref), setas `→`, uma linha por fato |

Trocar: "modo conciso ultra", "modo conciso lite". Desligar: "modo normal". Religar: "modo conciso".

## Exemplos

- Normal: "Analisei o hook e o problema é que ele lê a branch atual, mas o workflow faz checkout detached, então a verificação falha."
- full: "Hook lê branch atual. Workflow faz checkout detached. Falha. Corrigi com `ref: RELEASE`."
- ultra: "Checkout detached → hook falha. `ref: RELEASE`."

## Auto-clareza: volte ao normal em

Código, comandos, commits, PRs, `docs/`, `entrega.md`, specs; textos de UI e mensagens de erro citadas; avisos de segurança; confirmação de ação destrutiva ou irreversível (`git reset --hard`, deploy, apagar dados); passos em sequência em que o fragmento gera dúvida; usuário pedindo explicação detalhada ou repetindo a pergunta. Depois do trecho crítico, volte ao modo conciso.

## Nunca perca

Nomes de arquivo, símbolos, flags, números, caminhos e comandos exatos. Ambiguidade e risco continuam sendo avisados, só em menos palavras.
