# Regra de layering — onde a lógica vive no Exemplo SaaS

Aplicada em toda sessão. Complementa AGENTS.md §2 e §4.

## Direção de dependências

```
Flutter app
  └── chama → Firebase Functions (regras de negócio, autorização)
               └── lê/grava → Firestore / .NET API (persistência, domínio)
                              └── isolado do Flutter
```

- **Flutter** não contém regras de negócio. Só UI, chamadas e estado de apresentação.
- **Functions** contém autorização, validação de entrada, eventos de domínio e lógica cross-cutting.
- **.NET API** contém domínio rico, queries complexas, integrações externas.
- **Firestore** é cache de leitura e dado em tempo real; não é fonte de verdade para dados críticos.

## Regras concretas

| Onde NUNCA colocar | O que é | Onde vai |
|---|---|---|
| Tela Flutter | Cálculo de elegibilidade, permissão, preço | Service/use-case Flutter ou Function |
| Function | Lógica de renderização, formatação de tela | Flutter |
| Controller .NET | Regra de negócio (`if user.tier == "premium"`) | Domain service / use-case |
| Firestore | Validação de integridade (único, FK) | Function ou .NET |

## Flags `USE_API_*`

Quando `USE_API_*` está ativo para um domínio, **toda escrita** vai para o .NET e não para o Firestore diretamente. Leituras podem usar Firestore como cache. Se adicionar escrita num domínio migrado sem verificar a flag, você duplica o dado.

## Enums canônicos

Enums de domínio (`AccountKind`, `BusinessType`, etc.) vivem nos arquivos listados em `CANONICAL_ENUMS` (`.claude/hooks/lib/regras.mjs`). Redefinir fora desses arquivos gera aviso do hook `regras-de-dominio`.
