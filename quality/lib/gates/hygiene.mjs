// Gates de higiene por entrada (nível rápido).
// G1 (segredos): com GH_ACTIONS=false o Repository Security Guard do Actions não roda mais —
//   o diff adicionado passa a ser conferido aqui (padrões de provedor = fail; genérico = warn).
// G5 (optional chaining): optional chaining dessincroniza o parser do lizard e funde funções num
//   blob de complexidade (custou 4 iterações no QG-022/024) — proibido em código medido dos
//   scripts/libs. A marca de dois caracteres é montada por fromCharCode para o gate não se flagrar.
// Sem optional chaining neste arquivo.
import { isTest } from '../layers.mjs';
import { result } from '../report.mjs';
import { stripLiterals } from '../sanitize.mjs';

const MARCA = String.fromCharCode(63, 46); // os dois caracteres de optional chaining, sem digitá-los

const SEGREDOS = [
  ['AWS', /AKIA[0-9A-Z]{16}/],
  ['GitHub', /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['Slack', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['Google', /AIza[0-9A-Za-z_-]{35}/],
  ['OpenAI/Anthropic', /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/],
  ['Groq', /\bgsk_[A-Za-z0-9]{20,}\b/],
  ['chave privada', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./],
];
const SEGREDO_GENERICO = /(api[_-]?key|secret|token|senha|password)\s*[:=]\s*["'][^"'<>\s]{24,}["']/i;
const PLACEHOLDER = /<[^>]*>|\bvalor\b|\bseu[A-Za-z]*\b|\bxxx\b|\.\.\.|\$\{/i;
const ESCOPO_QSAFE = /(^|\/)(quality\/lib|scripts)\//;

const semComentario = (line) => line.replace(/(^|\s)\/\/.*$/, '');

/** Entrada elegível a gates por-linha: arquivo vivo, não-teste, com conteúdo novo. */
const aplicavel = (e) => e.status !== 'D' && !isTest(e.path) && e.newText != null;

/** Classifica UMA linha: { status, vendor } ou null. */
function sinalDeSegredo(line) {
  for (const [nome, re] of SEGREDOS) {
    if (re.test(line)) return { status: 'fail', vendor: nome };
  }
  if (SEGREDO_GENERICO.test(line) && !PLACEHOLDER.test(line)) return { status: 'warn', vendor: null };
  return null;
}

/** G1 — padrões de segredo nas linhas ADICIONADAS (fail = provedor conhecido; warn = genérico). */
export function secretsGate(e) {
  if (!aplicavel(e) || /\.(md|txt)$/.test(e.path)) return [];
  const out = [];
  for (const a of e.added) {
    const sinal = sinalDeSegredo(String(a.text ?? ''));
    if (!sinal) continue;
    const params = sinal.vendor ? { file: e.path, vendor: sinal.vendor } : { file: e.path };
    out.push(result('segredos', sinal.status, sinal.vendor ? 'secrets.fail' : 'secrets.warn', params));
  }
  return out.slice(0, 3);
}

/** Código (sem comentários/literais) da linha quando contém a marca de optional chaining; null senão. */
const codigoComMarca = (a) => {
  const codigo = stripLiterals(semComentario(String(a.text ?? '')), 'javascript');
  return codigo.includes(MARCA) ? codigo : null;
};

/** G5 — optional chaining em código novo de quality/lib e scripts: funde funções na medição do lizard. */
export function optionalChainingGate(e) {
  if (!aplicavel(e) || !/\.(mjs|js|cjs|ts)$/.test(e.path) || !ESCOPO_QSAFE.test(e.path)) return [];
  const out = [];
  for (const a of e.added) {
    const codigo = codigoComMarca(a);
    if (!codigo) continue;
    out.push(result('optional-chaining', 'fail', 'qsafe.fail', { file: e.path, trecho: codigo.trim().slice(0, 60) }));
    if (out.length >= 3) break;
  }
  return out;
}
