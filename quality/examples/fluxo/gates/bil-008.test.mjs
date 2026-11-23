// Gates BIL-008 — planos, checkout Pix, portal e chave idempotente no site. Templates Vitest do autor de gates; API falsa por fetch.
// O site não fala com Asaas nem com a API real em nenhum gate.
// ANTES da implementação cada gate DEVE falhar.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-10-31-billing-asaas-mercadopago BIL-008 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, exists, read, runOk, runVitestTemplates, walk } from './bil-gate-helper.mjs';

const SITE = 'ofluxo_site';
const PAGES = `${SITE}/src/platform/presentation/pages/billing`;
const FILES = [
  `${SITE}/src/platform/domain/billing-enums.ts`, `${SITE}/src/platform/domain/billing-contracts.ts`, `${SITE}/src/platform/domain/billing-idempotency.ts`,
  `${SITE}/src/platform/infrastructure/billing-api.ts`, `${PAGES}/plans-page.tsx`, `${PAGES}/checkout-page.tsx`, `${PAGES}/fiscal-data-form.tsx`, `${PAGES}/pix-step.tsx`,
  `${PAGES}/subscription-portal-page.tsx`,
];
const pagesTemplate = { 'GateBil008Pages.test.tsx': 'src/platform/presentation/pages/billing/GateBil008Pages.test.tsx' };
// Só o que existia na Fase B cita billing/assinar em lib/features; texto informativo de plano (BIL-015) não é compra.
const PURCHASE = /checkout|comprar|\bassinar\b|priceId|\/charges|billing\/subjects\/[^'"]*\/subscription/i;
const FLUTTER_KNOWN = [];

// Erro anterior a Billing (core-pages.tsx:1914, `location` sem uso), sem relação com esta entrega. Remover quando for corrigido.
const KNOWN_TS_ERROR = /core-pages\.tsx\(\d+,\d+\): error TS6133: 'location'/;

function assertFiles() {
  assert.deepEqual(FILES.filter((f) => !exists(f)), [], 'arquivos do site ausentes');
}

test('BIL-008 vitest: chave estável por intenção', () => {
  runVitestTemplates(SITE, { 'GateBil008Key.test.ts': 'src/platform/domain/GateBil008Key.test.ts' }, 4);
});

test('BIL-008 vitest: cliente envia Idempotency-Key só quando pedido', () => {
  runVitestTemplates(SITE, { 'GateBil008Client.test.ts': 'src/platform/infrastructure/GateBil008Client.test.ts' }, 8);
});

test('BIL-008 vitest: fluxo, consulta e portal', () => {
  runVitestTemplates(SITE, pagesTemplate, 15);
});

test('BIL-008 vitest: nenhuma tela do portal lê o documento claro', () => {
  const portal = read(`${PAGES}/subscription-portal-page.tsx`);
  assert.deepEqual((portal.match(/taxId\w*/g) ?? []).filter((name) => name !== 'taxIdMasked'), []);
  assert.deepEqual(walk(PAGES, (f) => /\.tsx?$/.test(f)).filter((f) => /localStorage/.test(read(f))), [], 'a chave e o fluxo ficam em sessionStorage');
});

test('BIL-008 vitest: rotas registradas e domain-pages não cresce além de 1953 linhas', () => {
  const app = read(`${SITE}/src/app/app.tsx`);
  assert.match(app, /path="\/planos"/, 'rota pública /planos');
  const platform = read(`${SITE}/src/platform/fluxo-platform.tsx`);
  assert.match(platform, /business\/:businessId\/plano"/);
  assert.match(platform, /business\/:businessId\/plano\/checkout\/:productCode"/);
  const domain = read(`${SITE}/src/platform/presentation/pages/domain-pages.tsx`);
  assert.match(domain, /Plano/);
  assert.ok(domain.split('\n').length - 1 <= 1953, 'domain-pages.tsx não pode crescer além das 1953 linhas de hoje (wc -l)');
  const enums = read('.claude/hooks/lib/regras.mjs');
  assert.ok(enums.includes('ofluxo_site/src/platform/domain/billing-enums.ts'), 'espelho fora de CANONICAL_ENUMS');
});

test('BIL-008 vitest: typecheck e lint do site', () => {
  assertFiles();
  const check = spawnSync('npx', ['tsc', '-b'], { cwd: path.join(ROOT, SITE), encoding: 'utf8', timeout: 85_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(check.error, undefined, `typecheck não executou: ${check.error?.message}`);
  const errors = `${check.stdout}\n${check.stderr}`.split('\n').filter((line) => /error TS\d+/.test(line));
  assert.deepEqual(errors.filter((line) => !KNOWN_TS_ERROR.test(line)), [], 'typecheck do site');
  runOk('npx', ['eslint', ...FILES.map((f) => f.replace(`${SITE}/`, '')), 'src/platform/infrastructure/fluxo-api-client.ts'], { cwd: path.join(ROOT, SITE), timeout: 30_000, label: 'lint do site' });
});

test('BIL-008 cdc-tela: informações obrigatórias antes da confirmação', () => {
  assert.ok(exists(`${PAGES}/checkout-page.tsx`), 'checkout-page.tsx ausente');
  const source = read(`${PAGES}/checkout-page.tsx`);
  assert.match(source, /terms-of-service/, 'link para os termos');
  runVitestTemplates(SITE, pagesTemplate, 2, { only: 'cdc:' });
});

test('BIL-008 csp-inalterada: firebase.json igual ao ponto de partida do branch e QR só por data:', () => {
  const base = spawnSync('git', ['merge-base', 'HEAD', 'main'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() || 'HEAD';
  const diff = spawnSync('git', ['diff', '--exit-code', '--stat', base, '--', 'firebase.json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(diff.status, 0, `firebase.json mudou:\n${diff.stdout}`);
  const csp = read('firebase.json');
  assert.match(csp, /connect-src[^"]*https:\/\/api\.ofluxo\.app/);
  assert.match(csp, /img-src[^"]*data:/);
  assertFiles();
  assert.match(read(`${PAGES}/pix-step.tsx`), /qrImageDataUri/);
  const site = [...FILES, `${SITE}/src/platform/infrastructure/fluxo-api-client.ts`];
  assert.deepEqual(site.filter((f) => /asaas/i.test(read(f))), [], 'o site não conhece o PSP');
  assert.deepEqual(site.filter((f) => /<iframe/i.test(read(f))), []);
});

test('BIL-008 sem-compra-flutter: lib/features não ganha compra B2B', () => {
  assertFiles();
  const hits = walk('lib/features', (f) => f.endsWith('.dart')).filter((f) => /billing|assinar/i.test(read(f)));
  assert.deepEqual(hits.filter((f) => !FLUTTER_KNOWN.includes(f) && PURCHASE.test(read(f))), []);
});

test('BIL-008 e2e-rotas: /planos abre sem erro de JavaScript', () => {
  const spec = read(`${SITE}/e2e/routes-smoke.spec.ts`);
  assert.match(spec, /\/planos/, 'routes-smoke.spec.ts não cobre /planos');
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'bil-e2e-'));
  try {
    const site = path.join(ROOT, SITE);
    runOk('npx', ['playwright', 'test', '--config', path.join(ROOT, 'quality/test/delivery/bil-web/playwright.planos.config.mjs'), '--grep', 'planos', 'routes-smoke'], {
      cwd: site, timeout: 105_000, label: 'Playwright em /planos',
      env: { ...process.env, CI: '1', BIL_GATE_SITE: site, BIL_GATE_E2E_DIR: path.join(site, 'e2e'), BIL_GATE_OUTPUT: output },
    });
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});
