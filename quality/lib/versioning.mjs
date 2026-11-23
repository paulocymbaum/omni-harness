// Versionamento por camada do projeto hospedeiro: bump semver determinístico a partir de commits
// convencionais desde a última tag da camada, salvo como tag `<camada>@vX.Y.Z` criada na
// branch release (e propagada para main e develop pelos merges do fluxo). Funções puras:
// recebem commits/versões/textos de manifest e devolvem planos e textos; git e FS ficam
// no CLI (quality/version/bump.mjs). Regra de bump: BREAKING CHANGE → major; feat → minor;
// qualquer outro commit que toque a camada → patch. Fonte única das camadas e arquivos:
// quality/config/layers.json (via layers.mjs).
import { LAYERS, layerOf } from './layers.mjs';

export const BASELINE = '0.1.0';
export const VERSION_TAG_RE = /^([A-Za-z][\w-]*)@v(\d+)\.(\d+)\.(\d+)(?:\+(\d+))?$/;

/** Ambientes do projeto hospedeiro → ref git que alimenta o deploy do ambiente (fonte das versões). */
export const ENVIRONMENT_REFS = { prod: 'origin/main', hml: 'origin/RELEASE', dev: 'origin/develop' };
/** Front por plataforma: web = camada site; ios/android = camada flutter. */
export const PLATFORM_FRONTS = { web: 'site', ios: 'flutter', android: 'flutter' };
/** Subcamadas de backend exibidas no rodapé do menu. */
export const BACKEND_PARTS = { api: 'backend', funcoes: 'functions', dados: 'rules' };
/** Artefato derivado (gerado pelo bump): nunca entra no range de bump de nenhuma camada. */
export const VERSIONS_JSON_PATH = 'ofluxo_site/public/versions.json';
const DERIVED_FILES = new Set([VERSIONS_JSON_PATH]);

/** Camadas com manifest que declara versão; as demais são versionadas só por tag. */
export const MANIFESTS = {
  flutter: { path: 'pubspec.yaml', kind: 'pubspec' },
  'admin-web': { path: 'admin-web/package.json', kind: 'package-json' },
  site: { path: 'ofluxo_site/package.json', kind: 'package-json' },
  'debate-worker': { path: 'services/debate-worker/package.json', kind: 'package-json' },
  'creator-worker': { path: 'services/creator-worker/package.json', kind: 'package-json' },
  'creator-render': { path: 'packages/creator-render/package.json', kind: 'package-json' },
  functions: { path: 'functions/package.json', kind: 'package-json' },
  backend: { path: 'backend/Directory.Build.props', kind: 'msbuild' },
};

export const LAYER_IDS = LAYERS.map((l) => l.id);

export function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:\+([0-9]+))?$/.exec(String(text).trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], build: m[4] == null ? null : +m[4] } : null;
}

export function formatVersion(v) {
  return v.build == null ? `${v.major}.${v.minor}.${v.patch}` : `${v.major}.${v.minor}.${v.patch}+${v.build}`;
}

export function parseLayerTag(name) {
  const m = VERSION_TAG_RE.exec(name ?? '');
  return m ? { layer: m[1], version: { major: +m[2], minor: +m[3], patch: +m[4], build: m[5] == null ? null : +m[5] } } : null;
}

/** Nome da tag da camada (núcleo semver, sem sufixo de build — o build vive no manifest). */
export function layerTagName(layer, version) {
  return `${layer}@v${version.major}.${version.minor}.${version.patch}`;
}

const gt = (a, b) => (a.major !== b.major ? a.major > b.major : a.minor !== b.minor ? a.minor > b.minor : a.patch > b.patch);

/** Versão mais alta entre tags `camada@vX.Y.Z` de uma camada (ou null). */
export function highestLayerVersion(tagNames, layer) {
  let best = null;
  for (const name of tagNames) {
    const t = parseLayerTag(name);
    if (t?.layer === layer && (best === null || gt(t.version, best))) best = t.version;
  }
  return best;
}

export function bumpVersion(version, level) {
  if (level === 'major') return { ...version, major: version.major + 1, minor: 0, patch: 0 };
  if (level === 'minor') return { ...version, minor: version.minor + 1, patch: 0 };
  if (level === 'patch') return { ...version, patch: version.patch + 1 };
  return version;
}

const BREAKING_SUBJECT = /^[A-Za-z]+(\([^)]*\))?!:/;
const BREAKING_BODY = /^BREAKING[ -]CHANGE:/m;
const FEAT_SUBJECT = /^feat(\(|:)/;

/** Nível de bump dos commits (sem merge) que tocaram a camada; null quando não há. */
export function classifyBump(commits) {
  let level = null;
  for (const { subject, body = '' } of commits) {
    if (BREAKING_SUBJECT.test(subject) || BREAKING_BODY.test(body)) return 'major';
    if (FEAT_SUBJECT.test(subject)) level = 'minor';
    else if (level === null) level = 'patch';
  }
  return level;
}

/** Versão da camada: tag mais alta; sem tag, a versão do manifest; por fim a baseline. */
export function currentVersion(layer, tagNames = [], manifestText = null) {
  const manifest = parseManifestVersion(manifestText, MANIFESTS[layer]?.kind);
  const tagged = highestLayerVersion(tagNames, layer);
  // A tag não carrega o sufixo +build (vive no manifest): sem herdá-lo, o próximo --apply
  // regravaria `1.2.3` sem build e o Flutter cairia para build 1 (versionCode não monotônico).
  if (tagged) return manifest?.build == null ? tagged : { ...tagged, build: manifest.build };
  return manifest ?? parseVersion(BASELINE);
}

const MANIFEST_PATTERNS = {
  pubspec: /^version:\s*(\S+)\s*$/m,
  msbuild: /<Version>\s*([^<\s]+)\s*<\/Version>/,
  'package-json': /"version"\s*:\s*"([^"]+)"/,
};

export function parseManifestVersion(text, kind) {
  if (!text || !kind) return null;
  const m = (MANIFEST_PATTERNS[kind] ?? MANIFEST_PATTERNS['package-json']).exec(text);
  return m ? parseVersion(m[1]) : null;
}

/** Aplica a versão ao texto do manifest preservando o restante (ex.: sufixo +build do pubspec). */
export function applyManifestVersion(text, version, kind) {
  const next = formatVersion(version);
  if (kind === 'pubspec') return text.replace(/^(\s*version:\s*)\S+$/m, `$1${next}`);
  if (kind === 'msbuild') {
    if (MANIFEST_PATTERNS.msbuild.test(text)) return text.replace(/(<Version>\s*)[^<\s]+(\s*<\/Version>)/, `$1${next}$2`);
    return text.replace(/(<PropertyGroup>\s*\n)/, `$1    <Version>${next}</Version>\n`);
  }
  return text.replace(/("version"\s*:\s*)"[^"]+"/, `$1"${next}"`);
}

/** Agrupa commits por camada pelos arquivos tocados (ordem de layers.json decide o vencedor). */
export function commitsByLayer(commits, layerIds = LAYER_IDS) {
  const groups = new Map(layerIds.map((id) => [id, []]));
  for (const commit of commits) {
    for (const id of new Set(commit.files.map((f) => layerOf(f).id))) {
      if (groups.has(id)) groups.get(id).push(commit);
    }
  }
  return groups;
}

/** Plano de uma camada: null quando nenhum commit da tocou desde a base. */
export function planLayer({ layer, tagNames = [], manifestText = null, commits = [] }) {
  const level = classifyBump(commits);
  if (!level) return null;
  const from = currentVersion(layer, tagNames, manifestText);
  return { layer, from, to: bumpVersion(from, level), level, commits: commits.length };
}

/** Remove artefatos derivados (ex.: versions.json) dos arquivos de um commit. */
export function stripDerivedFiles(files) {
  return (files ?? []).filter((f) => !DERIVED_FILES.has(f));
}

/** Versão da camada em uma lista de tags alcançáveis (null quando nunca tagueada lá). */
function versionIn(tags, layer) {
  const v = highestLayerVersion(tags ?? [], layer);
  return v ? formatVersion(v) : null;
}

/**
 * Manifest de versões por ambiente consumido pelo rodapé do menu (front e back).
 * `tagsByEnv`: nome do ambiente → tags `<camada>@vX.Y.Z` alcançáveis na ref do ambiente.
 * Determinístico: depende só das tags; `generatedAt` vem do commit HEAD.
 */
export function buildVersionsManifest({ tagsByEnv = {}, generatedAt = null } = {}) {
  const environments = {};
  for (const [env, tags] of Object.entries(tagsByEnv)) {
    const front = {};
    for (const [platform, layer] of Object.entries(PLATFORM_FRONTS)) front[platform] = versionIn(tags, layer);
    const backend = {};
    for (const [part, layer] of Object.entries(BACKEND_PARTS)) backend[part] = versionIn(tags, layer);
    environments[env] = { front, backend };
  }
  return { schema: 1, generatedAt, environments };
}
