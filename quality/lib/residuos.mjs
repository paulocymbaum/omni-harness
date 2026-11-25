// Resíduos de IA (AI code smells determinísticos e textuais) para o gate de duplicação:
// export especulativo ("just in case"), código morto comentado, stubs de implementação
// pendente (marcadores clássicos com dois-pontos no comentário), exceção engolida sem
// explicação (catch vazio — o padrão da casa SEMPRE escreve o motivo no comentário, então
// comentário presente não dispara), nomes genéricos de LLM (processData, helper, manager…)
// e cópia renomeada (type-3: mesma estrutura, nome diferente). Ficam DE FORA por não
// serem determinísticos leves: APIs alucinadas e erros de tipo (gates de tipos/lint por
// stack), boolean traps, logs verbosos, style drift e comentários narrativos (lint/formato
// por stack).
// Funções puras; o gate compõe com analisaLote (clones.mjs) — sem ciclo de import.
import { stripLiterals } from './sanitize.mjs';
import { jaccard } from './clones.mjs';

const NOMES_VAGOS = new Set([
  'helper', 'helpers', 'util', 'utils', 'misc', 'stuff', 'manager', 'processor', 'handler',
  'dosomething', 'handlesomething', 'processdata', 'processstuff', 'temp', 'tmp', 'dummy',
  'foo', 'bar', 'baz', 'obj', 'myfunction', 'func1', 'function1', 'method1',
]);
const MARCADOR_STUB = /\b(TODO|FIXME|HACK|XXX):\s/g;
const CATCH_VAZIO = /catch\s*(?:\([^)]{0,160}\))?\s*\{\s*\}/g;
const EXCEPT_PASS = /except[^:\n]*:[ \t]*\n?[ \t]*pass\b/g;
const CODIGO_EM_COMENTARIO = /\b(const|let|var|function|class|return|if|for|while|def|import|export)\b[^\n]*[;{}<>=]/;
const LANGS_EXPORT = new Set(['javascript', 'typescript', 'tsx']);
const LANGS_COMENTARIO = new Set(['javascript', 'typescript', 'tsx', 'python']);
const linhaDe = (texto, indice) => texto.slice(0, indice).split('\n').length;

/** Exports declarados (família JS/TS, onde `export` é declaração). [{ nome, linha }] */
function exportsDe(texto, lang) {
  if (!LANGS_EXPORT.has(lang) || texto == null) return [];
  const re = /(?:^|\n)[ \t]*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)|(?:^|\n)[ \t]*export\s*\{([^}]*)\}/g;
  const out = [];
  for (const m of texto.matchAll(re)) {
    if (m[1]) out.push({ nome: m[1], linha: linhaDe(texto, m.index) });
    else for (const parte of m[2].split(',')) {
      const nome = parte.trim().split(/\s+as\s+/).pop().trim();
      if (nome) out.push({ nome, linha: linhaDe(texto, m.index) });
    }
  }
  return out;
}

/** Definição anônima do lizard (arrow sem nome): não entra em grupos por nome nem em deriva. */
const ehAnonima = (d) => d.curto == null || d.curto.includes('anonymous') || d.curto.includes('(');

/**
 * Export especulativo: sem NENHUM uso fora do próprio arquivo no escopo avaliado E sem uso
 * no repo (verificador injetado `usoExterno(nome, arquivo)` — cobre os seams de teste da
 * casa, que usam o export só em quality/test; sem verificador, vale só o escopo do lote).
 */
function exportsSemUso(arquivos, cfg, usoExterno) {
  if (arquivos.length < cfg.exporteMinArquivos) return [];
  const achados = [];
  for (const a of arquivos) {
    for (const ex of exportsDe(a.texto, a.lang)) {
      if (ex.nome.length < 4 || NOMES_VAGOS.has(ex.nome.toLowerCase())) continue;
      const uso = new RegExp(`\\b${ex.nome}\\b`);
      const usadoNoLote = arquivos.some((b) => b.path !== a.path && uso.test(b.texto));
      const usadoFora = typeof usoExterno === 'function' && usoExterno(ex.nome, a.path);
      if (!usadoNoLote && !usadoFora) achados.push({ kind: 'exporte', origem: { arquivo: a.path, linha: ex.linha }, funcao: ex.nome, escopo: arquivos.length });
      if (achados.length >= 10) return achados;
    }
  }
  return achados;
}

/** Linha é comentário com sintaxe de código (backup morto da versão antiga)? */
const ehComentarioCodigo = (linha) => {
  const m = /^[\t ]*(?:\/\/|#)[\t ]?(.*\S)[\t ]*$/.exec(linha);
  return m != null && CODIGO_EM_COMENTARIO.test(m[1]);
};

/** Runs de ≥ mínimo linhas consecutivas que passam em `teste`: [{ inicio, linhas }] (1-based). */
function runsDe(linhas, teste, minimo) {
  const marcas = linhas.map((l) => (teste(l) ? 1 : 0)).join('');
  const runs = [];
  for (const m of marcas.matchAll(/1+/g)) {
    if (m[0].length >= minimo) runs.push({ inicio: m.index + 1, linhas: m[0].length });
  }
  return runs;
}

/** Blocos de código morto comentado (≥ 3 linhas): [{ kind, origem, linhas }]. */
function comentadosDe(texto, lang) {
  if (!LANGS_COMENTARIO.has(lang) || texto == null) return [];
  const base = stripLiterals(texto, lang); // comentários preservados, strings esvaziadas
  return runsDe(base.split('\n'), ehComentarioCodigo, 3).slice(0, 2)
    .map((r) => ({ kind: 'comentado', origem: { arquivo: '', linha: r.inicio }, linhas: r.linhas }));
}

/** Marcadores de implementação pendente em código (string literal não conta). */
function stubsDe(texto, lang) {
  if (texto == null) return [];
  const base = stripLiterals(texto, lang);
  const achados = [];
  for (const m of base.matchAll(MARCADOR_STUB)) {
    achados.push({ kind: 'stub', origem: { arquivo: '', linha: linhaDe(base, m.index) }, marcador: m[0] });
    if (achados.length >= 3) break;
  }
  return achados;
}

/** Exceção engolida sem explicação: chaves de catch já fechadas (ou except: pass) — docstring não conta. */
function catchVazioDe(texto, lang) {
  if (texto == null) return [];
  const re = lang === 'python' ? EXCEPT_PASS : CATCH_VAZIO;
  const achados = [];
  for (const m of texto.matchAll(re)) {
    const antes = texto.slice(0, m.index);
    const inicio = antes.lastIndexOf('\n') + 1;
    const linhaTexto = texto.slice(inicio, m.index);
    if (/^\s*(?:\/\/|#|\*|\/\*)/.test(linhaTexto)) continue; // exemplo em documentação
    achados.push({ kind: 'catch', origem: { arquivo: '', linha: linhaDe(texto, m.index) } });
    if (achados.length >= 3) break;
  }
  return achados;
}

/** Nomes genéricos de LLM na declaração (processData, helper, manager…). */
function nomesVagos(defs) {
  return defs
    .filter((d) => d.curto != null && NOMES_VAGOS.has(d.curto.toLowerCase()))
    .slice(0, 5)
    .map((d) => ({ kind: 'vago', origem: { arquivo: d.arquivo, linha: d.linha }, funcao: d.funcao }));
}

/** Tamanhos compatíveis: o menor corpo tem ≥ 70% do vocabulário do maior. */
const mesmoTamanho = (a, b) => Math.min(a.tokens.size, b.tokens.size) / Math.max(a.tokens.size, b.tokens.size) >= 0.7;

/** Pares do grupo com nomes diferentes, tamanho compatível e Jaccard ≥ mínimo. */
function paresDeriva(grupo, cfg) {
  const pares = [];
  for (let i = 0; i < grupo.length; i += 1) {
    for (let j = i + 1; j < grupo.length; j += 1) {
      const a = grupo[i];
      const b = grupo[j];
      if (a.funcao === b.funcao || a.hash === b.hash) continue;
      if (!mesmoTamanho(a, b)) continue;
      const valor = jaccard(a.tokens, b.tokens);
      if (valor < cfg.derivaMinimo) continue;
      pares.push({ kind: 'deriva', origem: a, destino: b, valor });
    }
  }
  return pares;
}

/** Cópia renomeada (type-3): estrutura quase idêntica, nome diferente, baldes determinísticos. */
function derivaClones(defs, cfg) {
  const nomeadas = defs.filter((d) => !ehAnonima(d));
  const substanciais = nomeadas.filter((d) => d.tokens.size >= cfg.derivaTokens);
  const baldes = new Map();
  for (const d of substanciais) {
    const balde = Math.floor(d.tokens.size / 10);
    if (!baldes.has(balde)) baldes.set(balde, []);
    baldes.get(balde).push(d);
  }
  const achados = [];
  for (const k of [...baldes.keys()].sort((x, y) => x - y)) {
    const grupo = [...(baldes.get(k) || []), ...(baldes.get(k + 1) || [])];
    if (grupo.length > cfg.maxGrupo) continue;
    achados.push(...paresDeriva(grupo, cfg));
  }
  return achados;
}

/**
 * Resíduos do lote. `definicoes` = defs de função de analisaLote (curto/longName/tokens).
 * `usoExterno` (nome, arquivo → bool) injeta a checagem repo-wide do gate para não brigar
 * com os seams de teste da casa. Export especulativo exige escopo ≥ exporteMinArquivos:
 * com 1 arquivo é impossível julgar uso externo, e o gate nunca denuncia o que não pode saber.
 */
export function residuosDe(arquivos, definicoes, cfg, usoExterno) {
  const achados = [...exportsSemUso(arquivos, cfg, usoExterno)];
  for (const a of arquivos) {
    for (const c of comentadosDe(a.texto, a.lang)) achados.push({ ...c, origem: { arquivo: a.path, linha: c.origem.linha } });
    for (const s of stubsDe(a.texto, a.lang)) achados.push({ ...s, origem: { arquivo: a.path, linha: s.origem.linha } });
    for (const cv of catchVazioDe(a.texto, a.lang)) achados.push({ ...cv, origem: { arquivo: a.path, linha: cv.origem.linha } });
  }
  achados.push(...nomesVagos(definicoes));
  achados.push(...derivaClones(definicoes, cfg));
  return achados;
}
