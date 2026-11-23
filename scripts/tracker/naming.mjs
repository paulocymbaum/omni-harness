// Regras de nomenclatura dos itens do Jira (documento: docs/jira/regras-de-epicos-e-cards.md).
//   Épico  → summary = título da feature (sem id de backlog, sem data, sem prefixo), até 120 caracteres
//   Card   → summary = "<ID> — <título da tarefa>", até 200 caracteres
//   Labels → feature-<slug> · versao-<tag> · categorias · spec-pendente · brd-pendente · fluxo-pendente
export const EPIC_SUMMARY_MAX = 120;
export const CARD_SUMMARY_MAX = 200;
export const PENDING_LABELS = { spec: 'spec-pendente', brd: 'brd-pendente', fluxo: 'fluxo-pendente' };

const collapse = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
export const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

/** Título do épico: o da feature, limpo (sem "Backlog —", sem espaços repetidos). */
export function epicSummary(backlog) {
  const title = collapse(backlog?.title).replace(/^(backlog|entrega|feature)\s*[—:-]\s*/i, '');
  return clip(title || collapse(backlog?.id) || 'Feature sem título', EPIC_SUMMARY_MAX);
}

/** Título do card da tarefa: ID e título, cabendo no limite. */
export function cardSummary(task) {
  return clip(collapse(`${task.id} — ${task.title}`), CARD_SUMMARY_MAX);
}
