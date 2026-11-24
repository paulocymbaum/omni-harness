// Exemplo SaaS local de release (sem GitHub Actions): decisões puras do script
// scripts/deploy/local/release-bump.mjs. Git e gh ficam no CLI; aqui só nome da branch,
// ordem de propagação e escolha da ref a validar. Espelha o que release-tag.yml faz no Actions.
import { formatVersion, highestLayerVersion, parseLayerTag } from './versioning.mjs';

/** Branches que recebem a release, na ordem: deploy (RELEASE), produção (main) e backmerge (develop). */
export const PROPAGATE_TO = ['RELEASE', 'main', 'develop'];

const gt = (a, b) => (a.major !== b.major ? a.major > b.major : a.minor !== b.minor ? a.minor > b.minor : a.patch > b.patch);

/**
 * Nome da branch `release/x.y.z` do plano de bump: a MAIOR versão-alvo entre as camadas
 * (sem o sufixo +build). Plano vazio devolve null: não há o que versionar.
 */
export function releaseBranchFor(rows) {
  const targets = (rows ?? []).map((row) => row.to).filter(Boolean);
  if (targets.length === 0) return null;
  const best = targets.reduce((acc, v) => (gt(v, acc) ? v : acc));
  return `release/${formatVersion({ ...best, build: null })}`;
}

/** Tags criadas por um `--apply`: as que existem depois e não existiam antes (ordenadas). */
export function newTags(before, after) {
  const had = new Set(before);
  return [...after].filter((tag) => !had.has(tag)).sort();
}

/** Refs `refs/tags/<tag>` para um push atômico junto com a branch. */
export const tagRefs = (tags) => tags.map((tag) => `refs/tags/${tag}`);

/**
 * Refs onde procurar a tag de uma branch: a local E a remota, as que existirem. A tag conta como
 * alcançada se estiver em qualquer uma (a local pode estar velha; a remota pode estar atrás de um
 * merge ainda não publicado). Nenhuma existente devolve lista vazia (a branch está ausente).
 */
export function refsToCheck(branch, exists) {
  return [branch, `origin/${branch}`].filter((ref) => exists(ref));
}

/** Quais destinos ainda não contêm a branch da release (precisam de PR/merge). */
export function pendingTargets(contains) {
  return PROPAGATE_TO.filter((target) => !contains(target));
}

const RELEASE_RE = /^release\/(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/;

/**
 * Nome livre para a release: se `release/x.y.z` já existe (release anterior com a mesma versão-alvo), usa
 * `release/x.y.z-2`, `-3`… — EXCETO quando a branch existente está TOTALMENTE propagada (nenhum destino
 * pendente): aí o nome pode ser reciclado (o CLI apaga a branch velha, já presente em RELEASE/main/develop,
 * e recorta de novo de origin/develop). Sem isso o script tomaria a branch antiga por "já publicada" e
 * pularia o bump; com reciclagem, a proliferação release/x.y.z-2, -3… acaba (QG-025).
 */
export function uniqueReleaseBranch(name, exists, liberadaParaReuso = null) {
  let candidate = name;
  for (let n = 2; exists(candidate); n++) {
    if (liberadaParaReuso && liberadaParaReuso(candidate)) return candidate;
    candidate = `${name}-${n}`;
  }
  return candidate;
}

/** Estratégia de propagação da release: PR via gh com Actions ligado; merge local com GH_ACTIONS=false (QG-024). */
export const estrategiaPropagacao = (ghActionsEnabled) => (ghActionsEnabled ? 'gh-pr' : 'merge-local');

/** A `release/x.y.z[-N]` mais recente entre os nomes dados (maior versão; na mesma versão, maior N; fora do padrão é ignorado). */
export function latestReleaseBranch(names) {
  let best = null;
  for (const name of names ?? []) {
    const m = RELEASE_RE.exec(name);
    if (!m) continue;
    const v = { major: +m[1], minor: +m[2], patch: +m[3] };
    const seq = m[4] ? +m[4] : 1;
    const newer = best === null || gt(v, best.v) || (!gt(best.v, v) && seq > best.seq);
    if (newer) best = { name, v, seq };
  }
  return best?.name ?? null;
}

/**
 * A release/* mais RECENTE (nomes em ordem de commit, do mais novo ao mais antigo). Serve para retomar a
 * propagação: o número da versão engana (a release `release/23.47.76`, nomeada pelo flutter, vence `release/0.3.1`
 * por versão mesmo sendo antiga), então a ordem é a do histórico.
 */
export function newestReleaseBranch(namesNewestFirst) {
  return (namesNewestFirst ?? []).find((name) => RELEASE_RE.test(name)) ?? null;
}

/**
 * A tag é a mais alta da própria camada? Só ela precisa bater com o manifest: as anteriores
 * (ex.: backend@v0.1.0 depois de backend@v0.2.0) ficam no histórico e não divergem de nada.
 */
export function isLatestLayerTag(tag, allTags) {
  const parsed = parseLayerTag(tag);
  if (!parsed) return false;
  const best = highestLayerVersion(allTags, parsed.layer);
  return best !== null && best.major === parsed.version.major && best.minor === parsed.version.minor && best.patch === parsed.version.patch;
}
