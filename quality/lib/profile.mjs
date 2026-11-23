// Perfil do projeto hospedeiro (R1 do harness agnóstico — docs/parking-lot/harness-agnostico.md).
// O núcleo é agnóstico: o que varia por projeto (locale, packs de política, camadas, globs, enums,
// matchers de domínio) vem do perfil em <repo>/quality/profile/<nome>.json; packs de política ficam
// no core (quality/packs/<nome>.json) e são ativados pelo perfil. Modelo de acoplamento decidido em
// R0: híbrido — núcleo vendored sincronizado, perfil vive no projeto (schema v1 validado aqui).
// Descoberta: env HARNESS_PROFILE (alias FLUXO_PROFILE) → único *.json em quality/profile/ →
// defaults genéricos. Erro de schema NUNCA derruba o consumidor: loadProfile devolve defaults +
// erros; quem reprova é o gate (quality/test/profile.test.mjs). Sem dependências; Node 22.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QUALITY_DIR, readJson } from './util.mjs';

export const SCHEMA_VERSION = 1;

const GENERATED_DEFAULTS = [
  '**/*.g.dart', '**/*.freezed.dart', '**/*.mocks.dart', '**/*.gr.dart', '**/Migrations/**',
  '**/node_modules/**', '**/dist/**', '**/build/**', '**/*.lock', '**/package-lock.json',
  '**/pnpm-lock.yaml', '**/pubspec.lock', '**/*.min.js', 'quality/.state/**', 'quality/reports/**',
];
const TESTS_DEFAULTS = [
  '**/test/**', '**/tests/**', '**/__tests__/**', '**/*.test.{ts,tsx,js,mjs,cjs}', '**/*.spec.{ts,tsx,js}',
  '**/*Tests.cs', '**/test_*.py', '**/*_test.py',
];

export const DEFAULTS = {
  schemaVersion: SCHEMA_VERSION,
  name: 'default',
  locale: 'pt-BR',
  packs: [],
  layers: [],
  riskMatrix: null,
  generatedGlobs: GENERATED_DEFAULTS,
  testGlobs: TESTS_DEFAULTS,
  featureMatchers: [],
  docsMatchers: [],
  docsGenerated: '',
  l10nPatterns: [],
  testHygiene: {},
  graphify: {},
  homologacao: {},
  autofix: { include: [] },
  enums: {},
  // R1.5 — motor sem path de produto: métricas do ratchet, runner flutter/TS e fronteiras.
  metrics: {},
  flutter: {},
  runnerTs: { workspaces: [] },
  dartPackage: '',
  boundaries: [],
  tracker: { provider: 'none' },
  runnerDotnet: {},
  runnerGo: {},
  runnerRust: {},
  runnerCpp: {},
  runnerJava: {},
  gitflow: null,
  prompt: { overlay: '', domainSkills: [], domainRules: [] },
  pii: { literalPatterns: [], publicLayers: [], rawDocFields: [], blockchainDeps: [] },
};

/** Descobre o arquivo do perfil. Puro; não lê conteúdo. */
export function discoverProfile(dir, env) {
  if (!fs.existsSync(dir)) return { file: null, files: [], erro: null };
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('schema'))
    .sort();
  const wanted = env.HARNESS_PROFILE || env.FLUXO_PROFILE || '';
  if (wanted) {
    const arquivo = files.find((f) => f === `${wanted}.json`);
    if (!arquivo) return { file: null, files, erro: `perfil "${wanted}" não existe em ${dir}` };
    return { file: path.join(dir, arquivo), files, erro: null };
  }
  if (files.length > 1) {
    return { file: null, files, erro: `vários perfis em ${dir} (${files.join(', ')}); defina HARNESS_PROFILE` };
  }
  if (files.length === 1) return { file: path.join(dir, files[0]), files, erro: null };
  return { file: null, files, erro: null };
}

/** Campos objeto opcionais do schema v1 — o perfil do hospedeiro pode omitir ou trazer {}. */
const CAMPOS_OBJETO = ['metrics', 'flutter', 'runnerTs', 'tracker', 'gitflow', 'runnerDotnet', 'runnerGo', 'runnerRust', 'runnerCpp', 'runnerJava'];

/** Valida o JSON bruto contra o schema v1. Devolve erros em pt-BR (lista vazia = válido). */
export function validateProfile(raw) {
  const erros = [];
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    erros.push('perfil deve ser um objeto JSON');
    return erros;
  }
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    erros.push(`schemaVersion deve ser ${SCHEMA_VERSION}; recebi ${JSON.stringify(raw.schemaVersion)}`);
  }
  if (typeof raw.name !== 'string' || !raw.name) erros.push('name deve ser string não vazia');
  if (typeof raw.locale !== 'string' || !raw.locale) erros.push('locale deve ser string não vazia');
  if (!Array.isArray(raw.packs) || raw.packs.some((p) => typeof p !== 'string')) {
    erros.push('packs deve ser lista de strings');
  }
  if (raw.layers != null) {
    if (!Array.isArray(raw.layers)) erros.push('layers deve ser lista');
    else {
      for (const l of raw.layers) {
        const ok = l != null && typeof l === 'object' && typeof l.id === 'string' && Array.isArray(l.globs);
        if (!ok) { erros.push('cada layer precisa de { id, globs[] }'); break; }
      }
    }
  }
  if (raw.riskMatrix != null && (typeof raw.riskMatrix !== 'object' || Array.isArray(raw.riskMatrix))) {
    erros.push('riskMatrix deve ser objeto');
  }
  if (raw.enums != null && (typeof raw.enums !== 'object' || Array.isArray(raw.enums))) {
    erros.push('enums deve ser objeto { nome: [arquivos] }');
  }
  const listas = [
    ['autofix.include', raw.autofix && raw.autofix.include], ['featureMatchers', raw.featureMatchers],
    ['docsMatchers', raw.docsMatchers], ['l10nPatterns', raw.l10nPatterns],
    ['generatedGlobs', raw.generatedGlobs], ['testGlobs', raw.testGlobs], ['boundaries', raw.boundaries],
  ];
  for (const [nome, v] of listas) {
    if (v != null && !Array.isArray(v)) erros.push(`${nome} deve ser lista`);
  }
  if (raw.boundaries != null) {
    for (const b of raw.boundaries) {
      const ok = b != null && typeof b === 'object' && typeof b.rule === 'string' && typeof b.applies === 'string';
      if (!ok) { erros.push('cada boundary precisa de { rule, applies, bad[], internalBad[] }'); break; }
    }
  }
  const objetos = CAMPOS_OBJETO;
  for (const nome of objetos) {
    const v = raw[nome];
    if (v != null && (typeof v !== 'object' || Array.isArray(v))) erros.push(`${nome} deve ser objeto`);
  }
  if (raw.tracker != null && typeof raw.tracker === 'object' && raw.tracker.provider != null && typeof raw.tracker.provider !== 'string') {
    erros.push('tracker.provider deve ser string (ex.: jira, none)');
  }
  if (raw.gitflow != null && typeof raw.gitflow === 'object' && raw.gitflow.permanent != null && !Array.isArray(raw.gitflow.permanent)) {
    erros.push('gitflow.permanent deve ser lista de strings');
  }
  if (raw.dartPackage != null && typeof raw.dartPackage !== 'string') erros.push('dartPackage deve ser string');
  if (raw.prompt != null) {
    const p = raw.prompt;
    if (typeof p !== 'object' || Array.isArray(p)) erros.push('prompt deve ser objeto');
    else {
      if (p.overlay != null && typeof p.overlay !== 'string') erros.push('prompt.overlay deve ser string (caminho relativo)');
      if (p.domainSkills != null && !Array.isArray(p.domainSkills)) erros.push('prompt.domainSkills deve ser lista');
      if (p.domainRules != null && !Array.isArray(p.domainRules)) erros.push('prompt.domainRules deve ser lista');
    }
  }
  return erros;
}

function lerPack(nome, erros) {
  const file = path.join(QUALITY_DIR, 'packs', `${nome}.json`);
  const pack = readJson(file, null);
  if (pack == null) erros.push(`pack "${nome}" não encontrado em ${file}`);
  return pack;
}

/** Funde os packs ativados no perfil (política PII, hoje). */
function aplicarPacks(base, erros) {
  base.pii = { literalPatterns: [], publicLayers: [], rawDocFields: [], blockchainDeps: [], ...base.pii };
  for (const nome of base.packs) {
    const pack = lerPack(nome, erros);
    if (pack == null) continue;
    base.pii.literalPatterns = base.pii.literalPatterns.concat(pack.piiPatterns || []);
    base.pii.publicLayers = base.pii.publicLayers.concat(pack.publicLayers || []);
    base.pii.rawDocFields = base.pii.rawDocFields.concat(pack.rawDocFields || []);
    base.pii.blockchainDeps = base.pii.blockchainDeps.concat(pack.blockchainDeps || []);
  }
  return base;
}

/** Carrega e valida o perfil. Nunca lança: devolve { profile, errors, file }.
 *  dir ausente → perfil da INSTALAÇÃO do harness (QUALITY_DIR/profile): QUALITY_ROOT muda o repo
 *  avaliado, não o perfil — fixtures de teste continuam com o perfil do projeto real. */
export function loadProfile(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  // Dir do perfil: explícito > root informado > HARNESS_PROFILE_DIR (ex.: quality/examples/fluxo) > instalação.
  const dir = o.dir
    || (o.root ? path.join(o.root, 'quality', 'profile') : undefined)
    || (env.HARNESS_PROFILE_DIR || path.join(QUALITY_DIR, 'profile'));
  const base = JSON.parse(JSON.stringify(DEFAULTS));
  const errors = [];
  const achado = discoverProfile(dir, env);
  if (achado.erro) errors.push(achado.erro);
  if (achado.file) {
    const raw = readJson(achado.file, null);
    if (raw == null) {
      errors.push(`perfil ilegível (JSON inválido): ${achado.file}`);
    } else {
      for (const m of validateProfile(raw)) errors.push(`${achado.file}: ${m}`);
      for (const chave of Object.keys(DEFAULTS)) {
        if (chave === 'schemaVersion') continue; // o schema é do MOTOR, não do arquivo
        if (raw[chave] !== undefined) base[chave] = raw[chave];
      }
      base.name = raw.name || base.name;
      base.locale = raw.locale || base.locale;
    }
  }
  return { profile: aplicarPacks(base, errors), errors, file: achado.file };
}

/** Expande "~" (dirs de cache de homologação no perfil). */
export function expandHome(p) {
  if (typeof p !== 'string' || !p.startsWith('~')) return p;
  return path.join(os.homedir(), p.slice(1));
}

const carregado = loadProfile({ env: process.env });

/** Perfil ativo do processo (singleton; hooks e gates leem daqui). */
export const PROFILE = carregado.profile;
export const PROFILE_ERRORS = carregado.errors;
export const PROFILE_FILE = carregado.file;
