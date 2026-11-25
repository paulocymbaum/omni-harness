import fs from 'node:fs';
import path from 'node:path';
import { QUALITY_DIR } from './util.mjs';
import { PROFILE } from './profile.mjs';

const LOCALE = PROFILE.locale || 'pt-BR';

/** Catálogo do locale do perfil; fallback incondicional para pt-BR (locale de referência). */
function loadCatalog(locale) {
  try {
    return JSON.parse(fs.readFileSync(path.join(QUALITY_DIR, `messages.${locale}.json`), 'utf8'));
  } catch {
    return JSON.parse(fs.readFileSync(path.join(QUALITY_DIR, 'messages.pt-BR.json'), 'utf8'));
  }
}

const LOCALE_USED = LOCALE;
export const catalog = loadCatalog(LOCALE);

const nf = new Intl.NumberFormat(LOCALE_USED, { maximumFractionDigits: 1 });
const RAW_PARAMS = new Set(['line', 'hash', 'sha', 'code', 'seconds']);

export function fmtNumber(n) {
  return nf.format(n);
}

export function fmtPercent(ratio) {
  return `${nf.format(ratio * 100)} %`;
}

/** Formata a mensagem `key` do catálogo. Números usam pt-BR, exceto parâmetros crus (linha, hash…). */
export function t(key, params = {}) {
  const tpl = key.split('.').length === 2 && typeof catalog[key] !== 'string'
    ? catalog[key.split('.')[0]]?.[key.split('.')[1]]
    : catalog[key];
  if (typeof tpl !== 'string') throw new Error(`Mensagem ausente no catálogo: ${key}`);
  return tpl.replace(/\{(\w+)\}/g, (_, name) => {
    const v = params[name];
    if (v === undefined || v === null) return '—';
    if (typeof v === 'number' && !RAW_PARAMS.has(name)) return fmtNumber(v);
    return String(v);
  });
}

export const statusLabel = (s) => catalog.status[s];
export const levelLabel = (l) => catalog.level[l];
export const tierLabel = (tier) => catalog.tier[tier];
