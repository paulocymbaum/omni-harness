// Gate de duplicação estrutural (nível rápido, lote): clone exato → REPROVADO;
// quase-clone (Jaccard) e nome repetido (≥ N arquivos) → ALERTA. Tipos só com corpo
// idêntico. Reusa a medição lizard do lote de complexidade (zero spawn extra) e analisa
// apenas o texto dos arquivos do escopo — determinístico e leve. Mensagens no catálogo pt-BR.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, repoRoot } from '../util.mjs';
import { isGenerated, isSource, isTest, languageOf } from '../layers.mjs';
import { lizardBatch, lizardCommand } from '../tools.mjs';
import { analisaLote } from '../clones.mjs';
import { residuosDe } from '../residuos.mjs';
import { result } from '../report.mjs';

const TH = loadConfig('thresholds');
const PADRAO = {
  corpoMinNloc: 6, tipoMinLinhas: 10, nomeMinArquivos: 3,
  jaccardMinimo: 0.85, tokensMinimos: 12, maxGrupo: 8,
  derivaMinimo: 0.9, derivaTokens: 30, exporteMinArquivos: 2,
};
const MAX_ACHADOS = 30;

const cfgDe = () => ({ ...PADRAO, ...(TH.duplicacao || {}) });
const alvoDe = (e) => isSource(e.path) && !isTest(e.path) && !isGenerated(e.path) && e.newText != null;

/** kind → [status, key, params extras]; fallback = quase-clone. Tabela declarativa determinística. */
const SAIDA_KIND = {
  clone: ['fail', 'duplicacao.cloneCorpo', () => ({})],
  tipo: ['fail', 'duplicacao.cloneTipo', (a) => ({ tipo: a.funcao })],
  deriva: ['warn', 'duplicacao.cloneRenomeado', (a) => ({ similaridade: Math.round(a.valor * 100) })],
  quase: ['warn', 'duplicacao.quaseClone', (a) => ({ similaridade: Math.round(a.valor * 100) })],
  nome: ['warn', 'duplicacao.nomeRepetido', (a) => ({ contagem: a.contagem, arquivos: a.arquivos.join(', ') })],
  exporte: ['warn', 'duplicacao.exporteSemUso', (a) => ({ escopo: a.escopo })],
  comentado: ['warn', 'duplicacao.codigoComentado', (a) => ({ linhas: a.linhas })],
  stub: ['warn', 'duplicacao.stub', (a) => ({ marcador: a.marcador })],
  catch: ['warn', 'duplicacao.excecaoVazia', () => ({})],
  vago: ['warn', 'duplicacao.nomeVago', () => ({})],
};

/** Converte um achado da lib em resultado de gate (file/line apontam para a cópia/resíduo). */
function resultadoDe(a) {
  const [status, key, extras] = SAIDA_KIND[a.kind] || SAIDA_KIND.quase;
  const destino = a.destino || a.origem;
  const params = {
    file: destino.arquivo, line: destino.linha,
    origem: a.origem.arquivo, origemLinha: a.origem.linha, funcao: a.funcao,
    ...extras(a),
  };
  return [result('duplicacao', status, key, params)];
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
  const cfg = cfgDe();
  const r = analisaLote(arquivos, cfg);
  const achados = [...r.achados, ...residuosDe(arquivos, r.definicoes, cfg, verificadorUsoExterno())];
  const out = achados.flatMap(resultadoDe);
  if (out.length === 0 && completo && r.funcoes > 0) {
    out.push(result('duplicacao', 'pass', 'duplicacao.pass', { funcoes: r.funcoes, tipos: r.tipos }));
  }
  return out.slice(0, MAX_ACHADOS);
}

const EXTENSOES_USO = /\.(mjs|cjs|js|ts|tsx|jsx|dart|py|rb|sh|md|json|ya?ml)$/i;
const PASTAS_PULADAS = new Set(['node_modules', 'graphify-out', '.git', '.state', '.cache']);

/** Textos do repo COM caminho, para checagem de uso (código, testes e docs referenciando símbolos). */
function coletaTextos(dir, raiz, textos) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return textos; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (PASTAS_PULADAS.has(e.name)) continue;
      coletaTextos(p, raiz, textos);
    } else if (EXTENSOES_USO.test(e.name)) {
      try { textos.push({ path: path.relative(raiz, p), texto: fs.readFileSync(p, 'utf8') }); } catch { /* ilegível: ignora */ }
    }
  }
  return textos;
}

/** Uso repo-wide de um símbolo EXCETO no arquivo que o declara: protege os seams de teste da casa (export usado só em quality/test). Corpus montado na primeira consulta. */
function verificadorUsoExterno() {
  let corpus = null;
  return (nome, arquivoOrigem) => {
    if (corpus == null) corpus = coletaTextos(repoRoot(), repoRoot(), []);
    const uso = new RegExp(`\\b${nome}\\b`);
    return corpus.some((b) => b.path !== arquivoOrigem && uso.test(b.texto));
  };
}
