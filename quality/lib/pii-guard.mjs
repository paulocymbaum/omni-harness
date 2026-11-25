// Dados pessoais e segredos em texto que vai para fora do repositório (cards do tracker). Regra do
// núcleo: nunca uid, e-mail, businessId, documento legal ou token em card. Função pura: devolve
// achados com o valor MASCARADO, nunca o valor bruto.
// Padrões de documento são o MECANISMO base deste módulo (sem acoplar a hooks de host); o pack
// `pii-br` do perfil define os padrões para o pipeline de regras de domínio (.claude/hooks).
const CPF = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g;
const CNPJ = /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g;
const isPlaceholder = (doc) => new Set(doc.replace(/\D/g, '')).size <= 1;

// O último rótulo do domínio tem de ser alfabético: `pnpm@9.15.0` e `satori@0.63.2` são pacote@versão, não e-mail.
const EMAIL = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/g;
// Domínios fictícios e contas de serviço do GCP (identidade de máquina, não de pessoa).
const FAKE_EMAIL_DOMAIN = /@(?:example\.(?:com|org|net)|exemplo\.[\w.]+|[\w-]+\.(?:test|invalid|localhost)|localhost|[\w-]+\.iam\.gserviceaccount\.com)$/i;
// CNPJs de fixture conhecidos (os do próprio gate de CNPJ alfanumérico e o exemplo oficial da Receita).
const TEST_DOCUMENTS = new Set(['11222333000181', '12345678000190', '12ABC34501DE35']);
const normalizeDocument = (value) => value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
const isTestDocument = (value) => TEST_DOCUMENTS.has(normalizeDocument(value));
// Identificador seguido de um valor longo (uid do Firebase tem 28 caracteres): evita casar prosa.
const IDENTIFIER = /\b(uid|userId|user_id|businessId|business_id|ownerUid|ownerId)\b["'\s:=]+["']?([A-Za-z0-9_-]{16,})/gi;
const TOKEN_PATTERNS = [
  /\bATATT[A-Za-z0-9_=-]{20,}/g, // token da API do Atlassian/Jira
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /\b(?:token|secret|api[_-]?key|password|senha)["'\s]*[:=]\s*["']?[A-Za-z0-9/+_=-]{24,}/gi,
];
const MAX_FINDINGS = 20;

/** Mostra só as pontas do valor: nunca devolve o dado bruto. */
const maskValue = (value) => (value.length <= 6 ? '***' : `${value.slice(0, 2)}***${value.slice(-2)}`);

const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const allSame = (value) => new Set(value.replace(/[^A-Za-z0-9]/g, '')).size <= 1;

function matches(text, regex, kind, accept = () => true, pick = (m) => m[0]) {
  const out = [];
  for (const m of text.matchAll(new RegExp(regex.source, regex.flags))) {
    const value = pick(m);
    if (accept(value)) out.push({ kind, masked: maskValue(value), line: lineOf(text, m.index) });
  }
  return out;
}

/** Achados de dados pessoais ou segredos no texto: [{ kind, masked, line }], no máximo 20. */
export function findPersonalData(text) {
  const body = String(text ?? '');
  if (!body) return [];
  const all = [
    ...matches(body, CPF, 'CPF', (v) => !isPlaceholder(v)),
    ...matches(body, CNPJ, 'CNPJ', (v) => !isPlaceholder(v) && !isTestDocument(v)),
    ...matches(body, EMAIL, 'e-mail', (v) => !FAKE_EMAIL_DOMAIN.test(v)),
    ...matches(body, IDENTIFIER, 'identificador', (v) => !allSame(v), (m) => m[2]),
    ...TOKEN_PATTERNS.flatMap((re) => matches(body, re, 'token')),
  ];
  const seen = new Set();
  const unique = all.filter((f) => !seen.has(`${f.kind}|${f.line}`) && seen.add(`${f.kind}|${f.line}`));
  return unique.slice(0, MAX_FINDINGS);
}

/** Frase pt-BR com os tipos e as linhas (sem o valor): "CPF (12***34, linha 5); e-mail (…)". */
export function describeFindings(findings) {
  return findings.map((f) => `${f.kind} (${f.masked}, linha ${f.line})`).join('; ');
}
