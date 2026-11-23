# Política de segurança

## Versões suportadas

| Versão | Suportada |
|---|---|
| última `main` (tag mais recente) | ✅ |
| anteriores | ❌ |

## Reportar vulnerabilidade

**Não abra issue pública com detalhes.** Use o [GitHub Security Advisory / private vulnerability reporting](https://github.com/paulocymbaum/omni-harness/security/advisories/new) deste repositório.

Inclua: versão (`omni-harness --version`), host (`omni-harness doctor`), passos mínimos de reprodução e impacto. Resposta em até 7 dias; correção coordenada em release antes de qualquer divulgação.

## Escopo

- Incluído: execução arbitral via gates/hooks, vazamento de segredos pelo motor, bypass das evidências por hash, injeção via payload de hooks (hosts Claude Code/Cline).
- Fora do escopo: falhas das ferramentas externas (git, dotnet, flutter, pnpm, uv) e dos próprios hosts (Claude Code, Cline, Codex, VS Code, Antigravity, Kiro) — reporte aos mantenedores deles.
