// Gate de duplicação estrutural (nível rápido, lote): clone exato → REPROVADO;
// quase-clone (Jaccard) e nome repetido (≥ N arquivos) → ALERTA. Tipos só com corpo
// idêntico. Reusa a medição lizard do lote de complexidade (zero spawn extra) e analisa
// apenas o texto dos arquivos do escopo — determinístico e leve. Mensagens no catálogo pt-BR.
import { loadConfig } from '../util.mjs';
import { isGenerated, isSource, isTest, languageOf } from '../layers.mjs';
import { lizardBatch, lizardCommand } from '../tools.mjs';
import { analisaLote } from '../clones.mjs';
import { result } from '../report.mjs';

const TH = loadConfig('thresholds');
const PADRAO = { corpoMinNloc: 6, tipoMinLinhas: 10, nomeMinArquivos: 3, jaccardMinimo: 0.85, tokensMinimos: 12, maxGrupo: 8 };
const MAX_ACHADOS = 20;

const cfgDe = () => ({ ...PADRAO, ...(TH.duplicacao || {}) });
const alvoDe = (e) => isSource(e.path) && !isTest(e.path) && !isGenerated(e.path) && e.newText != null;

/** Converte um achado da lib em resultado de gate (file/line apontam para a cópia). */
function resultadoDe(a) {
  const destino = a.destino || a.origem;
  const base = { file: destino.arquivo, line: destino.linha, origem: a.origem.arquivo, origemLinha: a.origem.linha, funcao: a.funcao };
  if (a.kind === 'clone') return [result('duplicacao', 'fail', 'duplicacao.cloneCorpo', base)];
  if (a.kind === 'tipo') return [result('duplicacao', 'fail', 'duplicacao.cloneTipo', { ...base, tipo: a.funcao })];
  if (a.kind === 'nome') {
    return [result('duplicacao', 'warn', 'duplicacao.nomeRepetido', { ...base, contagem: a.contagem, arquivos: a.arquivos.join(', ') })];
  }
  return [result('duplicacao', 'warn', 'duplicacao.quaseClone', { ...base, similaridade: Math.round(a.valor * 100) })];
}

/**
 * Gate em LOTE dos arquivos alvo. `funcoesPorArquivo` (Map path → funções do lizard)
 * pode vir da medição de complexidade para não duplicar spawns; sem ele, mede aqui.
 * Chunk sem medição não gera pass global (nunca aprovar com base parcial).
 */
export function duplicacaoGateLote(alvo, funcoesPorArquivo) {
  const vivos = alvo.filter(alvoDe);
  if (vivos.length === 0 || !lizardCommand()) return [];
  let medidas = funcoesPorArquivo || null;
  if (medidas == null) medidas = lizardBatch(vivos.map((e) => ({ path: e.path, text: e.newText })), languageOf);
  if (medidas == null) return [];
  return julgaLote(vivos, medidas);
}

/** Veredito com as funções já medidas (sem spawn). Exportado como seam de teste. */
export function julgaLote(vivos, medidas) {
  const arquivos = [];
  let completo = true;
  for (const e of vivos) {
    const fns = medidas.get(e.path);
    if (fns == null) { completo = false; continue; }
    arquivos.push({ path: e.path, lang: languageOf(e.path), texto: e.newText, funcoes: fns });
  }
  const r = analisaLote(arquivos, cfgDe());
  const out = r.achados.flatMap(resultadoDe);
  if (out.length === 0 && completo && r.funcoes > 0) {
    out.push(result('duplicacao', 'pass', 'duplicacao.pass', { funcoes: r.funcoes, tipos: r.tipos }));
  }
  return out.slice(0, MAX_ACHADOS);
}
