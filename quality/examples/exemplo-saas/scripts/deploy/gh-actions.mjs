// Chave dura do caminho GitHub Actions (regra: .claude/rules/deploy-actions-billing.md).
//   GH_ACTIONS=false (default, hardcoded): NENHUMA chamada a `gh api`/`gh workflow`/probe/dispatch —
//   usar SOMENTE os scripts locais de qualidade e deploy (run.mjs, release-bump.mjs, deploy-*.sh).
//   GH_ACTIONS=true: religa o caminho Actions (billing renovado, esteiras disponíveis).
// O default é desligado de propósito: sem minutos no Actions, cada tentativa custa tempo e
// confunde o operador. Nada no repo liga sozinho — religar é override explícito de ambiente.
// ATENÇÃO: sem `?.` (optional chaining) aqui e em actions-quota.mjs — o parser do lizard
// dessincroniza em `?.` e funde as funções seguintes num único blob de complexidade.
export const GH_ACTIONS_ENABLED = process.env.GH_ACTIONS === 'true';

export const VEREDITO_DESLIGADO =
  'Actions DESLIGADO (GH_ACTIONS=false) — deploy por script local SEMPRE: node scripts/deploy/release.mjs --run <id> --local';

/** Mensagem de recusa quando o passo precisa de Actions e a chave está desligada; null quando pode seguir. */
export function recusaSemActions(s, modoLocal) {
  if (GH_ACTIONS_ENABLED) return null;
  if (modoLocal) return null;
  const tipo = s.executar && s.executar.tipo;
  if (tipo === 'cli') return null; // passo local (ex.: validacao, versionar): não depende de Actions
  if (!tipo && !s.workflowPath && !s.monitor) return null;
  return `GH_ACTIONS=false — Actions desligado. Rode o passo por script local: node scripts/deploy/release.mjs --run ${s.id} --local`;
}

/** Veredito do probe: com a chave desligada, responde DESLIGADO sem consultar nada. */
export function vereditoProbe(info, vereditoLigado) {
  if (!GH_ACTIONS_ENABLED) return VEREDITO_DESLIGADO;
  return vereditoLigado(info);
}

/** Payload --json: credito null = inconclusivo; desligado = chave dura ativa. */
export function vereditoJson(info) {
  const ok = info && info.ok;
  return { credito: GH_ACTIONS_ENABLED ? ok : null, desligado: !GH_ACTIONS_ENABLED, ...info };
}

/** Exit code do probe: 0 só com Actions ligado E crédito confirmado. */
export function exitCodeProbe(info) {
  if (!GH_ACTIONS_ENABLED) return 1;
  return info && info.ok ? 0 : 1;
}
