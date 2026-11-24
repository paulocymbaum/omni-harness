#!/usr/bin/env node
// CLI de versionamento por camada do Exemplo SaaS: bump determinístico (commits convencionais
// desde a última tag da camada) salvo como tag `<camada>@vX.Y.Z`. Exemplo SaaS: rodar na branch
// release, que depois é mergeada em main e backmergada em develop — as tags ficam
// alcançáveis nas três (validado por --check).
//   node quality/version/bump.mjs              plano (dry run, pt-BR)
//   node quality/version/bump.mjs --apply      grava manifests, commit e tags (só em release/* ou RELEASE)
//   node quality/version/bump.mjs --next <id> [--tagged-only]  imprime a versão (X.Y.Z[+build]) que a camada terá no próximo --apply, p/ builds;
//                                              com --tagged-only imprime vazio se a camada ainda não tem tag (a UI então não mostra versão)
//   node quality/version/bump.mjs --init       tags de baseline (versão atual do manifest) nas camadas sem tag
//   node quality/version/bump.mjs --check      valida tags em main, develop e release (exit 2 se violar)
// Opções: --layer <id> (repetível), --base <ref> (sobrepõe a base do range), --head <ref> (range conta
// commits de outra ref, ex.: origin/develop — usado pelo gêmeo local da release), --json.
// Camadas e arquivos: quality/config/layers.json; política pura: quality/lib/versioning.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { run, repoRoot } from '../lib/util.mjs';
import { t } from '../lib/messages.mjs';
import { layerOf } from '../lib/layers.mjs';
import { isLatestLayerTag, refsToCheck } from '../lib/release-flow.mjs';
import {
  ENVIRONMENT_REFS, MANIFESTS, LAYER_IDS, VERSIONS_JSON_PATH, applyManifestVersion,
  buildVersionsManifest, currentVersion, formatVersion, highestLayerVersion,
  layerTagName, parseLayerTag, parseManifestVersion, planLayer, stripDerivedFiles,
} from '../lib/versioning.mjs';

const g = (args) => run('git', args, { cwd: repoRoot(), timeoutMs: 30_000 });
const readText = (rel) => { try { return fs.readFileSync(path.join(repoRoot(), rel), 'utf8'); } catch { return null; } };
const die = (message, code = 1) => { process.stderr.write(`${message}\n`); process.exit(code); };

const BOOLEAN_FLAGS = { '--apply': 'apply', '--check': 'check', '--init': 'init', '--json': 'json', '--tagged-only': 'taggedOnly' };

function options(argv) {
  const opts = { apply: false, init: false, taggedOnly: false, next: null, check: false, json: false, layers: [], base: null, head: null, versions: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (BOOLEAN_FLAGS[arg]) opts[BOOLEAN_FLAGS[arg]] = true;
    else if (arg === '--layer') opts.layers.push(argv[++i]);
    else if (arg === '--next') { opts.next = argv[++i]; opts.layers.push(opts.next); }
    else if (arg === '--base') opts.base = argv[++i];
    else if (arg === '--head') opts.head = argv[++i];
    else if (arg === '--versions') opts.versions = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : VERSIONS_JSON_PATH;
    else die(`Opção desconhecida: ${arg}`);
  }
  for (const id of opts.layers) {
    if (!LAYER_IDS.includes(id)) die(`Camada desconhecida: ${id}. Use uma de: ${LAYER_IDS.join(', ')}`);
  }
  return opts;
}

const currentBranch = () => {
  const r = g(['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.code === 0 ? r.stdout.trim() : null;
};
/** Branch que pode receber o bump: release/x.y.z (manual) ou a RELEASE longa que dispara o deploy. */
const isReleaseBranch = (b) => /^release\//.test(b ?? '') || b === 'RELEASE';
const worktreeClean = () => g(['status', '--porcelain']).stdout.trim() === '';
const listLayerTags = () => g(['tag', '--list', '*@v*']).stdout.split('\n').filter(Boolean);

/** Base do range de uma camada sem tag: bifurcação do head planejado com origin/develop (ou o commit raiz). */
function taglessBase(head) {
  const mb = g(['merge-base', head, 'origin/develop']);
  if (mb.code === 0) return mb.stdout.trim();
  const roots = g(['rev-list', '--max-parents=0', head]).stdout.trim().split('\n');
  return roots[roots.length - 1];
}

function loadCommits(base, head) {
  const range = `${base}..${head}`;
  const meta = g(['log', '--no-merges', range, '--pretty=format:%H%x1f%s%x1f%b%x1e']);
  const names = g(['log', '--no-merges', range, '--name-only', '--format=%H']);
  const filesByHash = new Map();
  let hash = null;
  const files = [];
  for (const line of names.stdout.split('\n')) {
    if (/^[0-9a-f]{40}$/.test(line)) { if (hash) filesByHash.set(hash, files.splice(0)); hash = line; continue; }
    if (hash && line.trim()) files.push(line.trim());
  }
  if (hash) filesByHash.set(hash, files);
  return meta.stdout.split('\x1e').filter((rec) => rec.trim()).map((rec) => {
    const [hash2, subject, body = ''] = rec.replace(/^\n/, '').split('\x1f');
    return { hash: hash2, subject, body, files: stripDerivedFiles(filesByHash.get(hash2) ?? []) };
  });
}

/** Tags de versão alcançáveis a partir de uma ref (deploy do ambiente), ou [] sem a ref. */
function reachableTags(ref) {
  if (!ref || g(['rev-parse', '--verify', '--quiet', ref]).code !== 0) return [];
  return listLayerTags().filter((tag) => g(['merge-base', '--is-ancestor', tag, ref]).code === 0);
}

/**
 * Gera o versions.json por ambiente (prod/hml/dev) consumido pelo rodapé do menu.
 * No apply (na release), prod e dev consideram também o HEAD da release: as tags acabam
 * de nascer nela e esse conteúdo vai para main (pipeline) e develop (backmerge obrigatório).
 */
function writeVersionsFile(target, prodExtraRef = null) {
  const releaseTags = reachableTags(prodExtraRef);
  const union = (ref) => [...new Set([...reachableTags(ref), ...releaseTags])];
  const tagsByEnv = {
    prod: union('origin/main'),
    hml: reachableTags(ENVIRONMENT_REFS.hml),
    dev: union('origin/develop'),
  };
  const head = g(['log', '-1', '--format=%cI']);
  const manifestData = buildVersionsManifest({ tagsByEnv, generatedAt: head.code === 0 ? head.stdout.trim() : null });
  const abs = path.join(repoRoot(), target);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(manifestData, null, 2)}\n`);
  return { abs, manifestData };
}

function buildPlan(opts) {
  // Head do planejamento: por padrão o checkout; o gêmeo local da release passa origin/develop
  // para que o plano não dependa da branch que está de pé na máquina (Cline, sessão paralela…).
  const head = opts.head ?? 'HEAD';
  if (opts.head && g(['rev-parse', '--verify', '--quiet', opts.head]).code !== 0) die(`Ref --head inexistente: ${opts.head}`);
  const layers = opts.layers.length ? opts.layers : LAYER_IDS;
  const tags = listLayerTags();
  const tagless = taglessBase(head);
  const commitsByBase = new Map();
  const rows = [];
  for (const layer of layers) {
    const manifest = MANIFESTS[layer];
    const latest = highestLayerVersion(tags, layer);
    // Base por camada: da própria tag (senão seria re-bumpada a cada release) ou do
    // bifurcation point com origin/develop quando a camada nunca foi tagueada.
    const base = opts.base ?? (latest ? layerTagName(layer, latest) : tagless);
    if (!commitsByBase.has(base)) commitsByBase.set(base, loadCommits(base, head));
    const layerCommits = commitsByBase.get(base).filter((c) => c.files.some((f) => layerOf(f).id === layer));
    const row = planLayer({
      layer,
      tagNames: tags,
      manifestText: manifest ? readText(manifest.path) : null,
      commits: layerCommits,
    });
    if (row) rows.push({ ...row, manifest: manifest?.path ?? null });
  }
  return { base: tagless, branch: currentBranch(), rows };
}

// CHECK_MARKER

function renderPlan({ base, branch, rows }) {
  if (rows.length === 0) return t('ver.plan.empty', { base: base.slice(0, 12), branch: branch ?? 'HEAD' });
  const lines = [t('ver.plan.header', { base: base.slice(0, 12), branch: branch ?? 'HEAD', count: rows.length })];
  for (const row of rows) {
    const note = row.manifest ? t('ver.plan.manifest', { path: row.manifest }) : '';
    lines.push(t('ver.plan.row', { layer: row.layer, from: formatVersion(row.from), to: formatVersion(row.to), level: row.level.toUpperCase(), commits: row.commits, manifest: note }));
  }
  return lines.join('\n');
}

function renderCheck(result) {
  if (result.total === 0) return t('ver.check.none');
  const lines = [];
  for (const row of result.rows) lines.push(t('ver.check.row', { tag: row.tag, status: row.ok ? t('ver.check.okRow') : t('ver.check.badRow', { problems: row.problems.join('; ') }) }));
  lines.unshift(result.ok ? t('ver.check.ok', { count: result.total }) : t('ver.check.header', { bad: result.rows.filter((r) => !r.ok).length, count: result.total }));
  return lines.join('\n');
}

/** Verifica cada tag de versão: alcançável em main, develop e release; manifest em sincronia. */
function runCheck() {
  const branch = currentBranch();
  const releaseRef = /^release\//.test(branch ?? '') ? branch : latestReleaseBranch();
  // Clone sem checkout local de main/develop: valida pela ref remota (origin/<branch>) em vez de acusar falta.
  const refExists = (ref) => g(['rev-parse', '--verify', '--quiet', ref]).code === 0;
  const targets = ['main', 'develop', ...(releaseRef ? [releaseRef] : [])];
  const reached = (tag, branch) => refsToCheck(branch, refExists).some((ref) => g(['merge-base', '--is-ancestor', tag, ref]).code === 0);
  const rows = [];
  const allTags = listLayerTags();
  for (const tag of allTags) {
    const parsed = parseLayerTag(tag);
    if (!parsed) continue;
    const problems = targets.filter((ref) => !reached(tag, ref))
      .map((ref) => t('ver.check.missing', { branch: ref }));
    const manifest = MANIFESTS[parsed.layer];
    // Só a tag mais alta da camada precisa bater com o manifest (as antigas ficam só no histórico).
    if (manifest && isLatestLayerTag(tag, allTags)) {
      const declared = parseManifestVersion(readText(manifest.path), manifest.kind);
      const same = declared && formatVersion(declared).split('+')[0] === `${parsed.version.major}.${parsed.version.minor}.${parsed.version.patch}`;
      if (!same) problems.push(t('ver.check.manifest', { path: manifest.path, manifest: declared ? formatVersion(declared) : '—', tag: formatVersion(parsed.version) }));
    }
    rows.push({ tag, ok: problems.length === 0, problems });
  }
  return { ok: rows.length > 0 && rows.every((r) => r.ok), total: rows.length, rows, targets };
}

/** Branch release/* mais recente conhecida (local, senão origin). */
function latestReleaseBranch() {
  const names = [...g(['for-each-ref', 'refs/heads', '--format=%(refname:short)']).stdout.split('\n').filter(Boolean),
    ...g(['for-each-ref', 'refs/remotes/origin', '--format=%(refname:short)']).stdout.split('\n').filter((n) => n !== 'origin/HEAD')];
  const versions = names
    .map((name) => ({ name, v: parseLayerTag(name.replace(/^origin\//, '').replace(/^release\//, 'release@v'))?.version ?? null }))
    .filter((x) => x.v && /^release\//.test(x.name.replace(/^origin\//, '')));
  versions.sort((a, b) => (a.v.major !== b.v.major ? b.v.major - a.v.major : a.v.minor !== b.v.minor ? b.v.minor - a.v.minor : b.v.patch - a.v.patch));
  return versions[0]?.name ?? null;
}

function runApply(plan, opts) {
  const branch = currentBranch();
  if (!isReleaseBranch(branch)) die(t('ver.apply.refuseBranch', { branch: branch ?? 'HEAD' }), 1);
  if (!worktreeClean()) die(t('ver.apply.refuseDirty'), 1);
  if (plan.rows.length === 0) die(t('ver.apply.refuseEmpty'), 1);
  // Validação antes de qualquer mutação: manifest declarado precisa existir.
  for (const row of plan.rows) {
    const manifest = MANIFESTS[row.layer];
    if (manifest && !fs.existsSync(path.join(repoRoot(), manifest.path))) {
      die(t('ver.apply.manifestMissing', { layer: row.layer, path: manifest.path }), 1);
    }
  }
  const lines = [];
  for (const row of plan.rows) {
    const manifest = MANIFESTS[row.layer];
    if (manifest) {
      const abs = path.join(repoRoot(), manifest.path);
      fs.writeFileSync(abs, applyManifestVersion(fs.readFileSync(abs, 'utf8'), row.to, manifest.kind));
      g(['add', manifest.path]);
      const commit = g(['commit', '-m', `chore(release): ${row.layer}@v${formatVersion(row.to)}`]);
      if (commit.code !== 0) die(t('ver.apply.commitFail', { layer: row.layer, detail: commit.stderr.trim() }), 1);
      lines.push(t('ver.apply.commit', { message: `chore(release): ${row.layer}@v${formatVersion(row.to)}` }));
    }
    const tag = layerTagName(row.layer, row.to);
    const tagged = g(['tag', '-a', tag, '-m', t('ver.tagMessage', { layer: row.layer, version: formatVersion(row.to) })]);
    if (tagged.code !== 0) die(t('ver.apply.tagFail', { tag, detail: tagged.stderr.trim() }), 1);
    lines.push(t('ver.apply.tagged', { tag }));
  }
  // Manifest de versões (derivado das tags): atualiza e versiona o arquivo no site.
  commitVersionsFile(opts?.versions ?? VERSIONS_JSON_PATH, lines);
  lines.push(t('ver.apply.done', { count: plan.rows.length, branch }));
  return lines.join('\n');
}

/** Regenera o versions.json (incluindo as tags novas do HEAD) e o commita se mudou. */
function commitVersionsFile(target, lines, { onlyIfChanged = false } = {}) {
  writeVersionsFile(target, 'HEAD');
  if (g(['status', '--porcelain', target]).stdout.trim()) {
    g(['add', target]);
    const commit = g(['commit', '-m', 'chore(release): manifest de versões']);
    if (commit.code !== 0) die(t('ver.apply.commitFail', { layer: 'versions', detail: commit.stderr.trim() }), 1);
    lines.push(t('ver.apply.versions', { path: target }));
  } else if (!onlyIfChanged) {
    lines.push(t('ver.apply.versionsClean', { path: target }));
  }
}

/** Tags de baseline: camadas sem tag recebem `<camada>@v<versão do manifest ou baseline>` no HEAD. */
function runInit(opts) {
  const branch = currentBranch();
  if (!isReleaseBranch(branch)) die(t('ver.apply.refuseBranch', { branch: branch ?? 'HEAD' }), 1);
  const tags = listLayerTags();
  const lines = [];
  for (const layer of opts.layers.length ? opts.layers : LAYER_IDS) {
    if (highestLayerVersion(tags, layer)) continue;
    const manifest = MANIFESTS[layer];
    const version = currentVersion(layer, [], manifest ? readText(manifest.path) : null);
    const tag = layerTagName(layer, version);
    const tagged = g(['tag', '-a', tag, '-m', t('ver.tagMessage', { layer, version: formatVersion(version) })]);
    if (tagged.code !== 0) die(t('ver.apply.tagFail', { tag, detail: tagged.stderr.trim() }), 1);
    lines.push(t('ver.apply.tagged', { tag }));
  }
  commitVersionsFile(opts.versions ?? VERSIONS_JSON_PATH, lines, { onlyIfChanged: true });
  lines.push(t('ver.init.done', { count: lines.length }));
  return lines.join('\n');
}

/** Versão da camada no próximo --apply: o plano (se houver) ou a atual (tag > manifest > baseline). */
function nextVersion(opts) {
  const layer = opts.next;
  if (opts.taggedOnly && !highestLayerVersion(listLayerTags(), layer)) return ''; // sem tag: a UI não inventa versão
  const row = buildPlan(opts).rows.find((r) => r.layer === layer);
  if (row) return formatVersion(row.to);
  const manifest = MANIFESTS[layer];
  return formatVersion(currentVersion(layer, listLayerTags(), manifest ? readText(manifest.path) : null));
}

function main(argv) {
  const opts = options(argv);
  if (opts.init) return { text: runInit(opts), code: 0 };
  if (opts.next) return { text: nextVersion(opts), code: 0 };
  if (opts.check) {
    const result = runCheck();
    return { text: opts.json ? JSON.stringify(result) : renderCheck(result), code: result.ok ? 0 : 2 };
  }
  if (opts.versions && !opts.apply) {
    const { abs, manifestData } = writeVersionsFile(opts.versions);
    return { text: opts.json ? JSON.stringify(manifestData) : t('ver.versions.written', { path: abs }), code: 0 };
  }
  const plan = buildPlan(opts);
  if (opts.json) return { text: JSON.stringify(plan), code: 0 };
  if (opts.apply) return { text: runApply(plan, opts), code: 0 };
  return { text: renderPlan(plan), code: 0 };
}

const result = main(process.argv.slice(2));
if (result?.text) process.stdout.write(`${result.text}\n`);
process.exit(result?.code ?? 0);
