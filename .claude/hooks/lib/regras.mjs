// Regras de domínio verificáveis por máquina. Funções puras: recebem caminho relativo e texto,
// devolvem achados. Consumidas por regras-de-dominio.mjs (PostToolUse) e lembrar-documentacao.mjs
// (Stop). Mensagens em pt-BR. Os DADOS (padrões PII, camadas públicas, enums canônicos, matchers
// de docs) vêm do perfil do projeto + packs (R1 do harness agnóstico — p.ex. pack `pii-br`);
// este módulo guarda só o MECANISMO, sem path de produto.
import { PROFILE } from '../../../quality/lib/profile.mjs';

const PII = PROFILE.pii || { literalPatterns: [], publicLayers: [], rawDocFields: [], blockchainDeps: [] };

function compileRe(spec, flags) {
  if (typeof spec === 'string') return new RegExp(spec, flags || '');
  return new RegExp(spec.re, spec.flags || flags || '');
}
const compileAll = (list, flags) => (list || []).map((s) => compileRe(s, flags));
const byId = (id) => {
  const found = (PII.literalPatterns || []).find((p) => p && p.id === id);
  return compileRe(found ? found.re : 'sem-padrao-x', 'g');
};

// Padrões de documento literal do pack ativo (pii-br: CPF/CNPJ). Exports mantidos por compat.
export const CPF = byId('cpf');
export const CNPJ = byId('cnpj');
const ALL_LITERAL = compileAll(PII.literalPatterns, 'g');
const PII_LABELS = (PII.literalPatterns || []).map((p) => (p && (p.label || p.id)) || '').filter(Boolean).join('/') || 'PII';

// Enums canônicos de domínio do perfil: redefinir fora daqui gera aviso.
export const CANONICAL_ENUMS = PROFILE.enums || {};
const ENUM_DEF = new RegExp(`\\b(?:enum|type|class|record)\\s+(${Object.keys(CANONICAL_ENUMS).join('|')})\\b`, 'g');

const TEST_OR_FIXTURE = [
  /(^|\/)(test|tests|__tests__|testdata|fixtures|e2e|integration_test)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /_test\.dart$/,
  /Tests?\.cs$/,
];
// Localização do projeto (ex.: lib/l10n, .arb) vem do perfil.
const L10N = compileAll(PROFILE.l10nPatterns);

// Camadas públicas do pack: o que sai do servidor para terceiros. Formulários em que o próprio
// usuário digita o documento não entram.
const PUBLIC_LAYER = compileAll(PII.publicLayers);
// Campo/propriedade chamado exatamente pelo nome do documento (cpfHash, cnpjMasked não casam).
const FIELDS = (PII.rawDocFields || []).join('|') || 'sem-campo-x';
const RAW_DOC_FIELD = new RegExp(`(?:["']?\\b(${FIELDS})\\b["']?\\s*[:=](?!=))|(?:\\b(?:string|String)\\??\\s+(${FIELDS})\\b)`, 'i');

// PARTE-2

const MANIFEST = /(^|\/)(package\.json|pubspec\.yaml|[^/]+\.csproj|pyproject\.toml)$/;
const BLOCKCHAIN_DEP = new RegExp(`["'\\s](${(PII.blockchainDeps || []).join('|') || 'sem-dep-x'})["'\\s:]`);

const matchesAny = (rel, patterns) => patterns.some((p) => p.test(rel));
export const isPlaceholder = (doc) => new Set(doc.replace(/\D/g, '')).size === 1;

/** Texto novo escrito pela ferramenta (Edit, MultiEdit ou Write). */
export function addedText(toolInput = {}) {
  if (typeof toolInput.content === 'string') return toolInput.content;
  if (Array.isArray(toolInput.edits)) return toolInput.edits.map((e) => e.new_string ?? '').join('\n');
  if (typeof toolInput.new_string === 'string') return toolInput.new_string;
  // Fallback para schemas desconhecidos: agrega campos string que não são paths/metadados
  const SKIP = new Set(['file_path', 'path', 'old_string', 'description', 'command', 'reason']);
  return Object.entries(toolInput)
    .filter(([k, v]) => typeof v === 'string' && !SKIP.has(k))
    .map(([, v]) => v)
    .join('\n');
}

/** Achados no texto adicionado a um arquivo. Devolve { bloqueios: string[], avisos: string[] }. */
export function checkContent(rel, text) {
  const result = { bloqueios: [], avisos: [] };
  if (!rel || !text || rel.startsWith('.claude/')) return result;
  checkLiteralDocs(rel, text, result);
  checkRawDocField(rel, text, result);
  checkEnumRedefinition(rel, text, result);
  checkBlockchainDep(rel, text, result);
  return result;
}

function checkLiteralDocs(rel, text, { bloqueios, avisos }) {
  if (matchesAny(rel, TEST_OR_FIXTURE) || matchesAny(rel, L10N)) return;
  const docs = [];
  for (const re of ALL_LITERAL) {
    for (const d of text.match(re) || []) docs.push(d);
  }
  const reais = docs.filter((d) => !isPlaceholder(d));
  if (!reais.length) return;
  const msg = `${rel}: ${reais.length} ${PII_LABELS} literal(is) (${mask(reais[0])}${reais.length > 1 ? ', …' : ''}). Documento legal nunca vai para código nem docs; use dados de teste em fixtures ou um placeholder (AGENTS.md §2.8).`;
  (rel.endsWith('.md') ? avisos : bloqueios).push(msg);
}

function checkRawDocField(rel, text, { avisos }) {
  if (!matchesAny(rel, PUBLIC_LAYER)) return;
  const m = text.match(RAW_DOC_FIELD);
  if (!m) return;
  const field = (m[1] ?? m[2]).toLowerCase();
  avisos.push(`${rel}: campo "${field}" bruto em camada pública. Exponha ${field}Hash ou uma referência segura, nunca o documento (skill identidade-e-privacidade).`);
}

function checkEnumRedefinition(rel, text, { avisos }) {
  if (rel.endsWith('.md')) return;
  for (const [, name] of text.matchAll(ENUM_DEF)) {
    const canonical = CANONICAL_ENUMS[name] ?? [];
    if (canonical.includes(rel)) continue;
    const where = canonical.length ? `já existe em ${canonical.join(', ')}` : 'ainda não tem arquivo canônico; registre-o na skill modelo-de-contas';
    avisos.push(`${rel}: enum de domínio ${name} redefinido; ${where}. Reutilize ou mapeie em vez de duplicar (AGENTS.md §2.5).`);
  }
}

function checkBlockchainDep(rel, text, { avisos }) {
  if (!MANIFEST.test(rel)) return;
  const m = text.match(BLOCKCHAIN_DEP);
  if (m) avisos.push(`${rel}: dependência de blockchain (${m[1]}). Blockchain não pode ser dependência obrigatória do core; isole atrás de uma abstração opcional e justifique na entrega (AGENTS.md §2.9).`);
}

function mask(doc) {
  return doc.replace(/\d/g, '•');
}

// ---------------------------------------------------------------- documentação (Stop)

// O que é "arquivo estrutural novo que pede .md" vem do perfil do projeto (R1).
const STRUCTURAL = (PROFILE.docsMatchers || []).map((d) => ({ re: new RegExp(d.re), label: d.label }));
const GENERATED = new RegExp(PROFILE.docsGenerated || '^$');

/**
 * Recebe linhas de `git status --porcelain -uall`. Devolve os arquivos novos estruturais
 * quando nenhum .md foi tocado; lista vazia quando não há o que lembrar.
 */
export function missingDocs(porcelainLines) {
  const entries = porcelainLines
    .filter((l) => l.length > 3)
    .map((l) => ({ status: l.slice(0, 2), path: l.slice(3).split(' -> ').pop().replace(/^"|"$/g, '') }));
  if (entries.some((e) => e.path.endsWith('.md'))) return [];
  return entries
    .filter((e) => e.status === '??' || e.status.includes('A'))
    .filter((e) => !GENERATED.test(e.path) && !matchesAny(e.path, TEST_OR_FIXTURE))
    .map((e) => ({ path: e.path, label: STRUCTURAL.find((s) => s.re.test(e.path))?.label }))
    .filter((e) => e.label);
}
