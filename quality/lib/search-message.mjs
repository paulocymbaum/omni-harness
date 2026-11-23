// Mensagem de bloqueio da guarda de busca (pt-BR), compartilhada pelos adaptadores de Claude e Cline.
import { t } from './messages.mjs';

/** Texto de bloqueio; acrescenta o aviso de grafo velho quando arquivos de código mudaram depois dele. */
export function denyMessage(decision) {
  const base = t(decision.key, decision.params);
  return decision.stale > 0 ? `${base} ${t('search.graphify.stale', { count: decision.stale })}` : base;
}

/** Dica de SessionStart sobre o estado do grafo; null quando está tudo certo. */
export function graphHint(status) {
  if (status.state === 'ausente') return t('search.graphify.hint.ausente');
  if (status.state === 'velho') return t('search.graphify.hint.velho', { count: status.stale.length });
  return null;
}
