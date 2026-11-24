// Gates BIL-001 — base documental: decisões de PSP, Orders do Mercado Pago e escopo das políticas de pagamento.
// ANTES da implementação cada gate DEVE falhar.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-10-31-billing-asaas-mercadopago BIL-001 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { DELIVERY, ROOT, read } from './bil-gate-helper.mjs';

const ARQ = 'docs/billing/FLUXO_BILLING_ARQUITETURA.md';
const PRIVACY = 'docs/payments/PAYMENT_PRIVACY_AND_RETENTION.md';
const REPORT = 'docs/payments/IMPLEMENTATION_REPORT.md';
const DELETE = 'docs/PRIVACY_DELETE.md';
const DOCS = [ARQ, PRIVACY, REPORT, DELETE];

// HEAD da Fase B: ponto de comparação do diff. Nada da BIL-001 existia aqui.
const ANCHOR = '2aff9441056719ab1f60b3c0a7fac6487429ba3f';
// Já estava fora de docs/ antes da entrega (só o caminho é comparado), ou é o próprio gate.
const NOT_FROM_BIL_001 = [/^\.env\.example$/, /^quality\/test\/delivery\/bil-/];

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);

function section(text, number) {
  const start = text.search(new RegExp(`^##\\s+§?${number}[.\\s]`, 'm'));
  assert.notEqual(start, -1, `seção ${number} ausente em ${ARQ}`);
  const rest = text.slice(start + 3);
  const end = rest.search(/^##\s/m);
  return end === -1 ? rest : rest.slice(0, end);
}

// Quebra de linha no Markdown não muda o texto: compara com espaços normalizados.
const flat = (text) => text.replace(/\s+/g, ' ');

const assertAll = (text, patterns, where) => {
  for (const pattern of patterns) assert.match(flat(text), pattern, `${where} deve conter ${pattern}`);
};

const assertNone = (text, patterns, where) => {
  for (const pattern of patterns) assert.doesNotMatch(flat(text), pattern, `${where} não pode conter ${pattern}`);
};

test('BIL-001 arquitetura: regras erradas de PSP saíram do texto', () => {
  assertNone(read(ARQ), [
    /mínima de 1 dia/, /D-2/, /HMAC header do Asaas/, /IsSignedWebhookPath/, /enfileirar via/, /PSP definitivo/,
    /AsaasWebhookVerifier/, /TryVerifySignature/, /billing_payment_methods/, /PaymentRail/, /payment-methods/,
    /payment_method\.(updated|revoked)/, /subject_type\(business\|profile\)/,
  ], ARQ);
});

test('BIL-001 arquitetura: correções por seção foram registradas', () => {
  assertAll(read(ARQ), [
    /asaas-access-token/, /billing_instruments/, /BIL-012/, /plano\.md/, /BIL-010/,
    /IPspWebhookAuthenticator/, /PspWebhookPaths\.IsPspWebhook/, /GetChargeAsync/, /BillingRail/, /AccountKind/,
    /tax_id_ciphertext/, /tax_id_hmac/, /tax_id_mask/, /instrument\./,
    /POST \/billing\/invoices\/\{id\}\/charges/, /billing-reconcile/, /D-5/,
    /\/v3\/pix\/automatic\/authorizations/, /paymentCreationMode/, /PIX_AUTOMATIC_RECURRING_AUTHORIZATION_REFUSED/,
    /PIX_AUTOMATIC_RECURRING_ELIGIBILITY_UPDATED/, /api-sandbox\.asaas\.com\/v3/,
    /\/v3\/subscriptions\/\{id\}\/invoiceSettings/, /INVOICE_AUTHORIZED/, /INVOICE_ERROR/, /pix_manual/,
  ], ARQ);
});

test('BIL-001 arquitetura: §18 traz as regras de desenho', () => {
  const rules = section(read(ARQ), 18);
  assert.match(rules.split('\n')[0], /Regras de desenho/);
  assertAll(rules, [/Gateways\/Asaas/, /[Ee]ntitlement/, /Flutter/, /HMAC/, /máscara/], '§18');
});

test('BIL-001 arquitetura: nenhum CPF ou CNPJ literal nos quatro documentos', async () => {
  const { checkContent } = await import(pathToFileURL(path.join(ROOT, '.claude/hooks/lib/regras.mjs')).href);
  assert.match(read(ARQ), /^##\s+§?18[.\s]/m, 'o documento ainda não foi corrigido');
  for (const doc of DOCS) {
    assert.deepEqual(checkContent(doc, read(doc)).avisos.filter((a) => a.includes('literal')), [], doc);
  }
});

test('BIL-001 mp-orders: §19 adota a API de Orders com os campos do contrato', () => {
  const mp = section(read(ARQ), 19);
  assert.match(mp.split('\n')[0], /Mercado Pago/);
  assertAll(mp, [
    /POST \/v1\/orders/, /GET \/v1\/orders\/\{id\}/, /legado/i,
    /type\W+online/, /processing_mode\W+automatic/, /payment_method\.id\W+pix/,
    /X-Idempotency-Key/, /expiration_time/, /30 minutos/, /30 dias/, /transactions\.payments/,
    /x-signature/, /22 ?s/, /mp-connect/, /painel/, /t[óo]pico\W+order\b/,
  ], '§19');
});

test('BIL-001 mp-orders: §19 traz o OAuth e fica condicionada ao spike', () => {
  const mp = section(read(ARQ), 19);
  assertAll(mp, [/PKCE/, /S256/, /\bstate\b/, /redirect_uri/, /10 minutos/, /180 dias/, /refresh/, /condicionada ao spike BIL-012/], '§19');
});

test('BIL-001 mp-orders: /v1/payments não aparece como caminho adotado', () => {
  const text = read(ARQ);
  section(text, 19);
  assertNone(text, [/\/v1\/payments/], ARQ);
});

test('BIL-001 escopo-pagamentos: a proibição continua e fica delimitada ao Pix coordenado', () => {
  const text = read(PRIVACY);
  assertAll(text, [
    /o Exemplo SaaS não pode receber, custodiar, liquidar, iniciar ou garantir Pix/,
    /Pix coordenado/, /não se aplica ao Billing/, /merchant/, /proposto, ainda sem efeito/, /BIL-013/, /BIL-014/,
  ], PRIVACY);
});

test('BIL-001 escopo-pagamentos: política traz a seção Dados de Billing', () => {
  const text = read(PRIVACY);
  assert.match(text, /^#+ .*Dados de Billing/m);
  const part = text.slice(text.search(/^#+ .*Dados de Billing/m));
  assertAll(part, [/execução de contrato/, /5 anos/, /180 dias/, /PAYMENTS_EVIDENCE_RETENTION_DAYS/], 'Dados de Billing');
});

test('BIL-001 escopo-pagamentos: relatório histórico aponta para a arquitetura sem ser reescrito', () => {
  const text = read(REPORT);
  assertAll(text, [
    /pagamento externo\. Não há SDK, webhook, consulta, custódia, liquidação, split, estorno ou garantia bancária/,
    /2026-08-05/, /FLUXO_BILLING_ARQUITETURA\.md/,
  ], REPORT);
});

test('BIL-001 escopo-pagamentos: exclusão de dados explica a guarda fiscal', () => {
  const text = read(DELETE);
  assert.match(text, /^#+ .*Guarda fiscal e cobrança/m);
  const part = text.slice(text.search(/^#+ .*Guarda fiscal e cobrança/m));
  assertAll(part, [
    /billing_customers/, /billing_invoices/, /billing_charges/, /billing_audit_events/,
    /FIRESTORE_PATHS/, /STORAGE_PATHS/, /5 anos/, /anonimiza/, /billing_email/, /NFS-e/,
  ], 'Guarda fiscal');
});

test('BIL-001 so-docs: os quatro documentos mudaram e nada fora de docs/ veio junto', () => {
  const changed = git('diff', '--name-only', ANCHOR, '--');
  for (const doc of DOCS) assert.ok(changed.includes(doc), `${doc} não mudou desde a Fase B`);

  // Depois que outra tarefa começa, o diff deixa de ser só da BIL-001. A prova vale no `mark done` da BIL-001, que vem antes.
  const backlog = JSON.parse(read(`${DELIVERY}/backlog.json`));
  const onlyBil001 = backlog.tasks.filter((t) => t.id !== 'BIL-001').every((t) => t.status === 'pending');
  if (onlyBil001) {
    const outside = [...changed, ...git('ls-files', '--others', '--exclude-standard')]
      .filter((f) => !f.startsWith('docs/') && !NOT_FROM_BIL_001.some((allowed) => allowed.test(f)));
    assert.deepEqual(outside, [], 'BIL-001 só pode alterar docs/');
  }
});
