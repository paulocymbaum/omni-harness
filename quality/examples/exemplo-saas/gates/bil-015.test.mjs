// Gates BIL-015 — cartão de plano no app, sem compra nem link de compra no iOS. Tudo Flutter: Exemplo SaaSApiClient e url_launcher falsos, sem API, loja nem PSP.
// O template fica em bil-flutter/ e só existe em test/features/billing durante o gate: teste do implementador não serve de prova do contrato.
// ANTES da implementação cada gate DEVE falhar.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-10-31-billing-asaas-mercadopago BIL-015 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, exists, read, walk } from './bil-gate-helper.mjs';

const BILLING = 'lib/features/billing';
const FILES = [
  `${BILLING}/billing_feature_flags.dart`, `${BILLING}/domain/business_plan_status.dart`, `${BILLING}/data/billing_api_datasource.dart`,
  `${BILLING}/presentation/cubit/business_plan_cubit.dart`, `${BILLING}/presentation/widgets/business_plan_card.dart`,
];
const TEMPLATE = 'quality/test/delivery/bil-flutter/GateBil015Card_test.dart';
const COPY = 'test/features/billing/gate_bil015_card_test.dart';
const PAGES = 'lib/features/fluxo_empresas/presentation/pages/fluxo_empresas_pages.dart';
const PAGES_LINES_BEFORE = 4594;

function assertFiles() {
  assert.deepEqual(FILES.filter((f) => !exists(f)), [], 'arquivos do cartão ausentes');
}

const tail = (text) => text.split('\n').slice(-30).join('\n');

function flutter(args, timeout = 110_000) {
  const r = spawnSync('flutter', args, { cwd: ROOT, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(r.error, undefined, `flutter não executou: ${r.error?.message}`);
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}

/** Copia o template, roda só os testes do prefixo e remove. Exige `minimum` verdes e nenhum pulado. */
function runCard(prefix, minimum) {
  assertFiles();
  const copy = path.join(ROOT, COPY);
  const made = !exists('test/features/billing');
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.copyFileSync(path.join(ROOT, TEMPLATE), copy);
  try {
    const { status, output } = flutter(['test', '--no-pub', '--reporter=compact', '--name', `${prefix}:`, COPY]);
    assert.equal(status, 0, `flutter test falhou:\n${tail(output)}`);
    const counts = [...output.matchAll(/\+(\d+)(?: ~(\d+))?(?: -(\d+))?:/g)].at(-1);
    assert.ok(counts, `sem contagem de testes:\n${tail(output)}`);
    assert.ok(Number(counts[1]) >= minimum, `esperava ao menos ${minimum} testes verdes, houve ${counts[1]}`);
    assert.equal(Number(counts[2] ?? 0), 0, 'teste pulado não conta como evidência');
  } finally {
    fs.rmSync(copy, { force: true });
    if (made) fs.rmSync(path.dirname(copy), { recursive: true, force: true });
  }
}

test('BIL-015 sem-compra-ios: no iOS, plano e texto exato, sem preço, botão nem link de compra', () => {
  // Variantes de plataforma contam um teste por plataforma.
  runCard('sem-compra-ios', 7);
});

test('BIL-015 sem-compra-ios: busca textual da spec em lib/features/billing', () => {
  assertFiles();
  const code = walk(BILLING, (f) => f.endsWith('.dart'));
  const forbidden = /R\$|amountCents|priceId|billing\/catalog|in_app_purchase|StoreKit|[Aa]ssinar|[Cc]omprar/;
  assert.deepEqual(code.filter((f) => forbidden.test(read(f))), []);
  const card = read(`${BILLING}/presentation/widgets/business_plan_card.dart`);
  assert.doesNotMatch(card, /SelectableText|Linkify/, 'o texto é Text comum');
});

test('BIL-015 flag-desligada: flags por plataforma desligadas, e ligar uma não liga a outra', () => {
  runCard('flag-desligada', 5);
});

test('BIL-015 flag-desligada: padrão false em tempo de compilação e nenhum build liga a flag', () => {
  assertFiles();
  const flags = read(`${BILLING}/billing_feature_flags.dart`);
  for (const name of ['BILLING_EXTERNAL_LINK_IOS', 'BILLING_EXTERNAL_LINK_ANDROID']) {
    assert.match(flags, new RegExp(`bool\\.fromEnvironment\\(\\s*'${name}'\\s*,\\s*defaultValue:\\s*false\\s*,?\\s*\\)`), name);
  }
  // .env* fica de fora de propósito: este gate não abre segredo.
  const builds = ['.github', 'scripts', 'ios/Flutter', 'ios/Runner.xcodeproj', 'android/app'].flatMap((dir) => walk(dir, (f) => !/(^|\/)\.env/.test(f) && !/\.(png|jpg|jar|keystore|jks)$/.test(f)));
  assert.ok(builds.length > 0, 'varredura vazia não prova nada');
  assert.deepEqual(builds.filter((f) => /BILLING_EXTERNAL_LINK_(IOS|ANDROID)\s*=\s*true/.test(read(f))), []);
});

test('BIL-015 sem-iap: in_app_purchase e StoreKit fora do app, e §8 da arquitetura com a estrutura real', () => {
  assertFiles();
  for (const file of ['pubspec.yaml', 'pubspec.lock']) assert.doesNotMatch(read(file), /in_app_purchase/, file);
  const native = walk('ios/Runner', (f) => /\.(swift|m|mm|h|entitlements)$/.test(f));
  assert.ok(native.length > 0, 'varredura vazia não prova nada');
  assert.deepEqual(native.filter((f) => /StoreKit|in-app-payments/.test(read(f))), []);
  assert.match(read('pubspec.yaml'), /^\s*url_launcher:/m);
  const architecture = read('docs/billing/FLUXO_BILLING_ARQUITETURA.md');
  const section = architecture.slice(architecture.search(/^## 8\b/m), architecture.search(/^## 9\b/m));
  assert.match(section, /business_plan_card\.dart/, '§8 cita a estrutura real');
  assert.match(section, /revisão/i, '§8 registra o risco de revisão da loja');
});

test('BIL-015 estados-do-cartao: dados, rótulos, ocultação e troca de empresa', () => {
  runCard('estados-do-cartao', 21);
});

test('BIL-015 estados-do-cartao: cartão no painel, fora do bloco de Pix, sem lógica nova na página', () => {
  assertFiles();
  const pages = read(PAGES);
  const dashboard = pages.slice(pages.indexOf('class DashboardPage'), pages.indexOf('_PixPaymentOperationsSection('));
  assert.ok(dashboard.length > 0, 'DashboardPage não encontrada');
  assert.match(dashboard, /BusinessPlanCard\(/, 'cartão antes de _PixPaymentOperationsSection');
  assert.ok(dashboard.indexOf('BusinessPlanCard(') < dashboard.indexOf('sl<PaymentFeatureFlags>()'), 'o cartão não depende da flag de Pix');
  assert.match(dashboard, /state\.businessId/, 'recarrega por state.businessId');
  assert.ok(pages.split('\n').length - 1 <= PAGES_LINES_BEFORE + 12, 'fluxo_empresas_pages.dart só recebe a inserção do cartão');
  const locator = read('lib/service_locator.dart');
  assert.match(locator, /BillingFeatureFlags/);
  assert.match(locator, /BillingApiDataSource/);
});

test('BIL-015 flutter-testes: analyze e testes do implementador e do painel', () => {
  assertFiles();
  const own = walk('test/features/billing', (f) => f.endsWith('_test.dart') && f !== COPY);
  assert.ok(own.length > 0, 'test/features/billing sem teste do implementador');
  const analyze = flutter(['analyze', '--no-pub', BILLING, 'test/features/billing'], 55_000);
  assert.equal(analyze.status, 0, `flutter analyze:\n${tail(analyze.output)}`);
  const run = flutter(['test', '--no-pub', 'test/features/billing', 'test/features/fluxo_empresas'], 60_000);
  assert.equal(run.status, 0, `flutter test:\n${tail(run.output)}`);
});
