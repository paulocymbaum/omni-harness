// Esvazia o conteúdo de strings (e regex em JS/TS) preservando comentários, aspas e quebras de linha.
// Evita falsos positivos: o lizard confunde aspas dentro de regex, e marcadores de supressão
// escritos dentro de strings não são supressões reais.

const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_KEYWORDS = /(?:^|[^\w$])(return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)\s*$/;

const OPTIONS = {
  javascript: { slashComments: true, regex: true, template: true },
  typescript: { slashComments: true, regex: true, template: true },
  tsx: { slashComments: true, regex: true, template: true, jsx: true },
  dart: { slashComments: true, triple: true, rawPrefix: true },
  csharp: { slashComments: true, verbatim: true },
  python: { hashComments: true, triple: true, rawPrefix: true },
};

const blank = (ch) => (ch === '\n' ? '\n' : ' ');

/** Comentário começando em i: devolve o índice final, ou -1. */
function commentEnd(text, i, o) {
  const c = text[i];
  const next = text[i + 1];
  const lineEnd = () => { const e = text.indexOf('\n', i); return e === -1 ? text.length : e; };
  if (o.slashComments && c === '/' && next === '/') return lineEnd();
  if (o.slashComments && c === '/' && next === '*') { const e = text.indexOf('*/', i + 2); return e === -1 ? text.length : e + 2; }
  if (o.hashComments && c === '#') return lineEnd();
  return -1;
}

// Em JSX, "/" depois de "<" fecha tag (</div>) e depois de "}" fecha elemento (<X a={b} />).
const JSX_NOT_REGEX = new Set(['<', '}']);

function looksLikeRegex(out, jsx) {
  let k = out.length - 1;
  while (k >= 0 && /\s/.test(out[k])) k--;
  if (k < 0) return true;
  if (jsx && JSX_NOT_REGEX.has(out[k])) return false;
  return REGEX_PREV.has(out[k]) || REGEX_KEYWORDS.test(out.slice(Math.max(0, k - 12), k + 1));
}

/** Regex literal a partir de i (que aponta para "/"). Devolve [texto esvaziado, novo índice]. */
function scanRegex(text, i) {
  let s = '/';
  let j = i + 1;
  let inClass = false;
  while (j < text.length && text[j] !== '\n') {
    const ch = text[j];
    if (ch === '\\') { s += '  '; j += 2; continue; }
    if (ch === '/' && !inClass) break;
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    s += ' ';
    j++;
  }
  if (text[j] === '/') { s += '/'; j++; }
  return [s, j];
}

/** Fim do conteúdo de uma string: devolve [texto esvaziado, índice do delimitador de fechamento]. */
function scanBody(text, j, kind) {
  let s = '';
  let depth = 0;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\\' && kind.escapes) { s += blank(ch) + blank(text[j + 1] ?? ''); j += 2; continue; }
    if (kind.template && ch === '$' && text[j + 1] === '{') { depth++; s += '  '; j += 2; continue; }
    if (kind.template && depth > 0 && ch === '}') { depth--; s += ' '; j++; continue; }
    if (kind.verbatim && ch === '"' && text[j + 1] === '"') { s += '  '; j += 2; continue; }
    if (depth === 0 && text.startsWith(kind.quote, j)) break;
    if (ch === '\n' && kind.singleLine) break; // string não terminada: não contamina o resto do arquivo
    s += blank(ch);
    j++;
  }
  return [s, j];
}

function stringKind(text, i, o) {
  const c = text[i];
  if (c !== '"' && c !== "'" && !(o.template && c === '`')) return null;
  const raw = Boolean(o.rawPrefix) && /[rR]/.test(text[i - 1] ?? '') && !/[\w$]/.test(text[i - 2] ?? '');
  const verbatim = Boolean(o.verbatim) && c === '"' && text[i - 1] === '@';
  const triple = Boolean(o.triple) && text[i + 1] === c && text[i + 2] === c;
  const template = c === '`';
  return {
    quote: triple ? c.repeat(3) : c,
    escapes: !raw && !verbatim,
    template,
    verbatim,
    singleLine: !triple && !template,
  };
}

export function stripLiterals(text, lang) {
  const o = OPTIONS[lang];
  if (!o || text == null) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const end = commentEnd(text, i, o);
    if (end !== -1) { out += text.slice(i, end); i = end; continue; }
    if (o.regex && text[i] === '/' && looksLikeRegex(out, o.jsx)) {
      const [s, j] = scanRegex(text, i);
      out += s;
      i = j;
      continue;
    }
    const kind = stringKind(text, i, o);
    if (kind) {
      const [body, j] = scanBody(text, i + kind.quote.length, kind);
      out += kind.quote + body;
      i = j;
      if (text.startsWith(kind.quote, i)) { out += kind.quote; i += kind.quote.length; }
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}
