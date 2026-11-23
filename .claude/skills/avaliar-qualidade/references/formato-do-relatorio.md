# Formato do relatório (pt-BR)

Use este modelo ao reportar uma avaliação ao usuário. Copie os valores da saída de `quality/run.mjs`, sem arredondar nem reinterpretar.

```markdown
## Qualidade da alteração

**Risco:** <NÍVEL> — quebra do backend: <NÍVEL> (<motivos>); escala de custo: <NÍVEL> (<motivos>)
**Nível executado:** <rápido|rotina|completo> (exigido: <nível>)
**Veredito:** <Pode entregar | Precisa corrigir | Precisa aprovação humana>

| Gate | Arquivo / escopo | Valor | Limite | Status |
|---|---|---|---|---|
| complexidade | lib/…/x.dart:120 `buildHeader` | 14 | 10 | ALERTA |
| testes | Flutter (test/features/feed) | 12 aprovados | — | APROVADO |

**Não medido:** <ferramenta ausente / delegado ao CI / tempo esgotado — ou "nada">
**Supressões novas:** <lista com justificativa — ou "nenhuma">
**Custo:** <deltas calculados (instâncias, execuções/dia, chamadas pagas) — ou "sem impacto">
```

## Regras do veredito

- **Pode entregar:** nenhum REPROVADO, o nível exigido foi executado e o risco de custo é baixo ou médio.
- **Precisa corrigir:** há REPROVADO, ou o nível exigido não foi executado.
- **Precisa aprovação humana:** risco crítico em qualquer eixo, ou custo alto, mesmo com todos os gates aprovados.

Liste só os ALERTAs relevantes para a mudança. Os APROVADOs podem ser resumidos numa linha ("12 gates aprovados").
