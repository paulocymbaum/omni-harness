import { loadConfig } from './util.mjs';
import { PROFILE } from './profile.mjs';
import { matchAny } from './glob.mjs';

// Camadas do projeto hospedeiro vêm do perfil (R1). Fallback: config/layers.json de hosts
// ainda não migrados para o perfil (removido na R5).
function layersLegadas() {
  try { return loadConfig('layers').layers || []; } catch { return []; }
}

export const LAYERS = PROFILE.layers.length ? PROFILE.layers : layersLegadas();

export function layerOf(file) {
  return LAYERS.find((l) => matchAny(file, l.globs)) ?? { id: 'outros', nome: 'Outros', stack: '—', globs: [] };
}

const GENERATED = PROFILE.generatedGlobs;

const TESTS = PROFILE.testGlobs;

export function isGenerated(file) {
  return matchAny(file, GENERATED);
}

export function isTest(file) {
  return matchAny(file, TESTS);
}

const LANG_BY_EXT = {
  '.dart': 'dart', '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.jsx': 'javascript', '.cs': 'csharp', '.py': 'python',
};

export function languageOf(file) {
  const m = /\.[a-z]+$/i.exec(file);
  return m ? LANG_BY_EXT[m[0].toLowerCase()] ?? null : null;
}

export function isSource(file) {
  return languageOf(file) !== null && !isGenerated(file);
}

/** Feature por matcher do perfil (ex.: flutterFeature, ocrPackage) ou null. */
function matchFeature(id, file) {
  for (const m of PROFILE.featureMatchers) {
    if (m.id !== id) continue;
    if (m.value != null) return m.value;
    const hit = new RegExp(m.re).exec(file);
    if (hit) return hit[m.group || 1] || null;
  }
  return null;
}

/** Feature Flutter (lib/features/<f>/…) ou null — matcher `flutterFeature` do perfil. */
export function flutterFeature(file) {
  return matchFeature('flutterFeature', file);
}

/** Pacote/app do workspace do projeto — matcher `ocrPackage` do perfil. */
export function ocrPackage(file) {
  return matchFeature('ocrPackage', file);
}
