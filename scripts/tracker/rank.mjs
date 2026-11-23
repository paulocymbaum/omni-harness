// Ranking do board: card novo (ou que mudou de coluna) sobe ao TOPO. Sem isto o Jira anexa o card ao fim
// da coluna — com Done de dezenas de cards, o card recém-criado fica fora da área visível e parece não
// existir no kanban. O ranking é global; como as colunas agrupam por status, ir para o topo do projeto
// significa ser o primeiro card da própria coluna.

/**
 * Põe `key` antes do primeiro card do ranking do projeto. Melhor esforço: ranking é cosmético e não pode
 * derrubar o sync (projeto sem campo Rank, board de outro projeto, token sem permissão de board).
 * Devolve `true` quando moveu (ou já era o primeiro) e `false` quando não foi possível.
 */
export async function rankToTop(jira, projectKey, key, log = console) {
  try {
    const first = await jira.firstRankedIssue(projectKey);
    if (first && first !== key) await jira.rankIssue(key, first);
    return true;
  } catch (error) {
    log.warn(`  Aviso: ${key} sincronizado, mas não subiu ao topo do board (${String(error.message).slice(0, 120)}).`);
    return false;
  }
}
