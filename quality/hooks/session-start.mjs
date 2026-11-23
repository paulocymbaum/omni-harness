#!/usr/bin/env node
// SessionStart: prepara ferramentas, limpa estado antigo e informa o Claude (pt-BR) sobre os gates ativos.
import { readStdinJson } from '../lib/util.mjs';
import { lizardCommand, warmLizard, toolInventory } from '../lib/tools.mjs';
import { pruneState } from '../lib/state.mjs';
import { t } from '../lib/messages.mjs';
import { repoRoot } from '../lib/util.mjs';
import { graphifyAvailable, graphStatus } from '../lib/search-guard.mjs';
import { healGraphLink } from '../lib/graph-storage.mjs';
import { graphHint } from '../lib/search-message.mjs';

try {
  readStdinJson();
  // Sem git NÃO silencia: o contexto de gates/ferramentas continua válido em hospedeiro novo
  // (a evidência por hash é que requer git — documentado em docs/harness/02-ciclo-de-sessao.md).
  pruneState();
  if (!lizardCommand()) warmLizard();
  const inv = toolInventory();
  const tools = Object.entries(inv).map(([k, v]) => `${k} ${v ? '✔' : '✘'}`).join(', ');
  // Dica do grafo (ausente ou velho) só faz sentido com a CLI instalada e a guarda ligada.
  healGraphLink(repoRoot());
  const hint = graphifyAvailable() && process.env.GRAPHIFY_HOOK_STRICT !== '0' ? graphHint(graphStatus(repoRoot())) : null;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: [t('hook.session', { tools }), hint].filter(Boolean).join('\n') },
  }));
} catch (err) {
  // Um hook de qualidade nunca deve impedir a sessão de começar.
  process.stderr.write(`quality/session-start: ${err.message}\n`);
}
process.exit(0);
