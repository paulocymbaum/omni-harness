// Detecção determinística e leve de duplicação estrutural (funções, métodos e tipos).
// Reflexão do code review de 2026-11-24: três famílias de clone no repo — cópia literal
// (program()×3), cópia que derivou (runDotnetGate×6, ~80% igual) e superfície espalhada
// (mesmo símbolo em N arquivos). Cada família vira um achado determinístico sobre texto
// normalizado (sem literais, comentários, números nem espaço): sha1 para clone exato,
// Jaccard de palavras para quase-clone (só dentro do grupo do mesmo longName) e contagem
// de arquivos para nome repetido. Tipos (class/interface/enum/struct/trait/record/
// protocol/extension/mixin) só viram achado com corpo idêntico em ≥2 arquivos — DTO
// homônimo entre camadas é padrão legítimo. Leve: puro texto, sem rede e sem spawn — as
// funções medidas vêm da medição lizard que o lote do tier rápido já faz. Sem optional
// chaining (G5 funde funções no lizard) e com funções curtas (gates da casa).
import { createHash } from 'node:crypto';
import { stripLiterals } from './sanitize.mjs';

// Linguagens com removedor de literais pronto (sanitize.mjs); as demais usam o scanner C-family.
const STRIP_LITERALS_LANGS = new Set(['javascript', 'typescript', 'tsx', 'dart', 'csharp', 'python']);
// Linguagens onde '#' abre comentário de linha (no C# é preprocessor — não tirar).
const HASH_LANGS = new Set(['python']);

/** Palavras ignoradas na regra de nome repetido: entry point padrão de CLI em toda stack. */
const NOMES_IGNORADOS = new Set(['main']);

/** Corpo de uma estrutura medida pelo lizard: linhas [start..end] (1-based, inclusive). */
export function corpoDe(base, fn) {
  if (base == null || fn == null || fn.start == null || fn.end == null) return '';
  return String(base).split('\n').slice(fn.start - 1, fn.end).join('\n');
}

/** Conteúdo esvaziado da string que abre em `abertura` (preserva \n) + índice do delimitador final. */
function corpoEsvaziado(texto, abertura) {
  const delim = texto[abertura];
  let vazio = '';
  let j = abertura + 1;
  while (j < texto.length && texto[j] !== delim) {
    vazio += texto[j] === '\n' ? '\n' : ' ';
    j += texto[j] === '\\' ? 2 : 1;
  }
  return [vazio, j];
}

/** Esvazia strings (preservando \n) para linguagens sem opção no sanitize: go, java, c, cpp. */
export function esvaziaCFamilia(texto) {
  let out = '';
  for (let i = 0; i < texto.length;) {
    const c = texto[i];
    if (c === '"' || c === "'" || c === '`') {
      const [vazio, fim] = corpoEsvaziado(texto, i);
      out += `${c}${vazio}${c}`;
      i = fim + 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Texto preparado para comparação: literais esvaziados e comentários apagados, PRESERVANDO
 * quebras de linha (os números de linha do lizard continuam batendo com o texto de entrada).
 */
export function prepara(texto, lang) {
  if (texto == null) return '';
  let base = STRIP_LITERALS_LANGS.has(lang) ? stripLiterals(texto, lang) : esvaziaCFamilia(String(texto));
  base = base.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  base = base.replace(/\/\/.*$/gm, '');
  if (HASH_LANGS.has(lang)) base = base.replace(/#.*$/gm, '');
  return base;
}

/** Forma canônica de um corpo: números viram N e espaço colapsa. Determinístico. */
export function normaliza(base) {
  return String(base).replace(/\b\d+(?:\.\d+)?\b/g, 'N').replace(/\s+/g, ' ').trim();
}

export const hashDe = (canonico) => createHash('sha1').update(canonico).digest('hex').slice(0, 16);

/** Conjunto de identificadores/palavras-chave do corpo canônico (para o Jaccard). */
export const tokensDe = (canonico) => new Set(canonico.match(/[A-Za-z_]\w*/g) || []);

/** Jaccard entre dois conjuntos de tokens (0 quando ambos vazios). */
export function jaccard(a, b) {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const uni = a.size + b.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

// ---------------------------------------------------------------- tipos (classes, interfaces…)

const TIPO_BRACED = /(?:^|\n)[ \t]*(?:(?:export|declare|public|private|protected|internal|abstract|final|sealed|partial|static|data|value|open)\s+)*(class|interface|enum|struct|trait|record|protocol|extension|mixin)[ \t]+([A-Za-z_]\w*)/g;
const TIPO_GO = /(?:^|\n)type[ \t]+([A-Za-z_]\w*)[ \t]+(?:struct|interface)\b/g;

function cascasDeTipos(base) {
  const cascas = [];
  for (const m of base.matchAll(TIPO_BRACED)) cascas.push({ nome: m[2], desde: m.index + m[0].length });
  for (const m of base.matchAll(TIPO_GO)) cascas.push({ nome: m[1], desde: m.index + m[0].length });
  return cascas;
}

/** Índice da chave que fecha a chave aberta em `abre` (texto já sem literais/comentários). */
function fechamentoDe(base, abre) {
  let depth = 0;
  for (let i = abre; i < base.length; i += 1) {
    if (base[i] === '{') depth += 1;
    if (base[i] === '}') depth -= 1;
    if (depth === 0) return i;
  }
  return null;
}

/** Corpo de tipo por balanceamento de chaves (texto já sem literais/comentários). */
function blocoChaves(base, desde) {
  const abre = base.indexOf('{', desde);
  if (abre === -1) return null;
  const fim = fechamentoDe(base, abre);
  if (fim == null) return null;
  return base.slice(abre, fim + 1);
}

const indentacaoDe = (linha) => (/^\s*/.exec(linha))[0];
const maisProfunda = (linha, raiz) => linha.startsWith(raiz) && /^\s/.test(linha.slice(raiz.length));

/** Corpo de tipo python: da linha da declaração até voltar à indentação dela. */
function blocoIndentacao(base, desde) {
  const linhas = base.split('\n');
  const idx = base.slice(0, desde).split('\n').length - 1;
  const raiz = indentacaoDe(linhas[idx] || '');
  const bloco = [linhas[idx]];
  for (let i = idx + 1; i < linhas.length; i += 1) {
    const linha = linhas[i];
    if (linha.trim() !== '' && !maisProfunda(linha, raiz)) break;
    bloco.push(linha);
  }
  return bloco.join('\n');
}

/** Tipos declarados num texto preparado: [{ nome, corpo, linha }]. */
export function tiposDe(base, lang) {
  const out = [];
  for (const casca of cascasDeTipos(base)) {
    const corpo = lang === 'python' ? blocoIndentacao(base, casca.desde) : blocoChaves(base, casca.desde);
    if (corpo == null) continue;
    const linha = base.slice(0, casca.desde).split('\n').length;
    out.push({ nome: casca.nome, corpo, linha });
  }
  return out;
}

// ---------------------------------------------------------------- análise do lote

const contaLinhas = (corpo) => corpo.split('\n').filter((l) => l.trim() !== '').length;

/** Funções elegíveis de um arquivo (dedupe por path:linha:nome; corpo ≥ mínimo OU vocabulário rico). */
function funcoesDeArquivo(a, base, cfg, vistas) {
  const defs = [];
  for (const f of a.funcoes || []) {
    const nloc = typeof f.nloc === 'number' ? f.nloc : 0;
    const chave = `${a.path}:${f.start}:${f.name}`;
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    const canonico = normaliza(corpoDe(base, f));
    if (canonico === '') continue;
    const tokens = tokensDe(canonico);
    // Corpo curto só entra quando o vocabulário é rico (ex.: program() com 5 linhas cheias
    // de operadores — cópia literal clássica); getters e delegações triviais ficam de fora.
    if (nloc < cfg.corpoMinNloc && tokens.size < cfg.tokensMinimos) continue;
    const def = { arquivo: a.path, funcao: f.longName || f.name, linha: f.start, hash: hashDe(canonico), tokens };
    defs.push(def);
  }
  return defs;
}

/** Tipos elegíveis de um arquivo (corpo não vazio com ≥ tipoMinLinhas linhas). */
function tiposDeArquivo(a, base, cfg) {
  const defs = [];
  for (const tp of tiposDe(base, a.lang)) {
    if (contaLinhas(tp.corpo) < cfg.tipoMinLinhas) continue;
    defs.push({ arquivo: a.path, funcao: tp.nome, linha: tp.linha, hash: hashDe(normaliza(tp.corpo)) });
  }
  return defs;
}

/** Definições elegíveis do lote (funções do lizard + tipos extraídos), já deduplicadas. */
function definicoesDe(arquivos, cfg) {
  const vistas = new Set();
  const funcoes = [];
  const tipos = [];
  for (const a of arquivos) {
    const base = prepara(a.texto, a.lang);
    funcoes.push(...funcoesDeArquivo(a, base, cfg, vistas));
    tipos.push(...tiposDeArquivo(a, base, cfg));
  }
  return { funcoes, tipos };
}

/** Cópia literal: mesmo corpo canônico (hash) em duas definições quaisquer do lote. */
function clonesExatos(defs, kind) {
  const porHash = new Map();
  for (const d of defs) {
    if (!porHash.has(d.hash)) porHash.set(d.hash, []);
    porHash.get(d.hash).push(d);
  }
  const achados = [];
  for (const grupo of porHash.values()) {
    for (let i = 1; i < grupo.length; i += 1) achados.push({ kind, origem: grupo[0], destino: grupo[i] });
  }
  return achados;
}

/** Mesmo longName em ≥ nomeMinArquivos arquivos, com corpos que NÃO são todos idênticos. */
function nomesRepetidos(defs, cfg) {
  const grupos = new Map();
  for (const d of defs) {
    if (NOMES_IGNORADOS.has(d.funcao)) continue;
    if (!grupos.has(d.funcao)) grupos.set(d.funcao, new Map());
    const porArquivo = grupos.get(d.funcao);
    if (!porArquivo.has(d.arquivo)) porArquivo.set(d.arquivo, d);
  }
  const achados = [];
  for (const [funcao, porArquivo] of grupos) {
    if (porArquivo.size < cfg.nomeMinArquivos) continue;
    const doNome = [...porArquivo.values()];
    const hashes = new Set(doNome.map((d) => d.hash));
    if (hashes.size <= 1) continue; // cópia literal: já reprovada como clone exato
    achados.push({ kind: 'nome', funcao, contagem: doNome.length, origem: doNome[0], arquivos: doNome.slice(0, 6).map((d) => d.arquivo) });
  }
  return achados;
}

/** Pares quase-clone dentro de um grupo (i<j; o valor é o Jaccard do par). */
function paresQuaseClones(grupo, cfg) {
  const pares = [];
  for (let i = 0; i < grupo.length; i += 1) {
    for (let j = i + 1; j < grupo.length; j += 1) {
      const valor = parQuaseClone(grupo[i], grupo[j], cfg);
      if (valor > 0) pares.push({ origem: grupo[i], destino: grupo[j], valor });
    }
  }
  return pares;
}

/** Par no mesmo grupo de longName com Jaccard ≥ mínimo e corpos que já divergiram. */
function quaseClones(defs, cfg) {
  const grupos = new Map();
  for (const d of defs) {
    if (NOMES_IGNORADOS.has(d.funcao)) continue;
    if (!grupos.has(d.funcao)) grupos.set(d.funcao, []);
    grupos.get(d.funcao).push(d);
  }
  const achados = [];
  for (const [funcao, grupo] of grupos) {
    const arquivos = new Set(grupo.map((d) => d.arquivo));
    if (arquivos.size < 2 || grupo.length > cfg.maxGrupo) continue;
    for (const par of paresQuaseClones(grupo, cfg)) {
      achados.push({ kind: 'quase', funcao, origem: par.origem, destino: par.destino, valor: par.valor });
    }
  }
  return achados;
}

/** Similaridade do par (0 = não é quase-clone): arquivos distintos, corpos divergidos, Jaccard ≥ mínimo. */
function parQuaseClone(a, b, cfg) {
  if (a.arquivo === b.arquivo || a.hash === b.hash) return 0;
  const menor = Math.min(a.tokens.size, b.tokens.size);
  if (menor < cfg.tokensMinimos) return 0;
  const valor = jaccard(a.tokens, b.tokens);
  return valor >= cfg.jaccardMinimo ? valor : 0;
}

/**
 * Analisa um lote de arquivos já medidos. `arquivos`: [{ path, lang, texto, funcoes }]
 * (funcoes = lista do lizardBatch para aquele path). Devolve { achados, funcoes, tipos };
 * achado: { kind: 'clone'|'tipo'|'nome'|'quase', origem, destino?, funcao, … } — determinístico.
 */
export function analisaLote(arquivos, cfg) {
  const { funcoes, tipos } = definicoesDe(arquivos, cfg);
  const achados = [
    ...clonesExatos(funcoes, 'clone'),
    ...clonesExatos(tipos, 'tipo'),
    ...nomesRepetidos(funcoes, cfg),
    ...quaseClones(funcoes, cfg),
  ];
  ordenaAchados(achados);
  return { achados, funcoes: funcoes.length, tipos: tipos.length };
}

/** Ordem estável: arquivo/linha do destino (ou da origem), depois a família do achado. */
function ordenaAchados(achados) {
  const chave = (a) => (a.destino || a.origem);
  achados.sort((x, y) => chave(x).arquivo.localeCompare(chave(y).arquivo)
    || (chave(x).linha || 0) - (chave(y).linha || 0)
    || x.kind.localeCompare(y.kind));
}
