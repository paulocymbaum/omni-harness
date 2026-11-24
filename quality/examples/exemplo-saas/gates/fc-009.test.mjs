// Gates FC-009 — módulo web do Creator (/app/business/:id/creator), prévia fiel e ambiente local com front.
// ANTES da implementação cada gate DEVE falhar.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-11-14-fluxo-creator FC-009 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, exists, read, stripComments } from './fc-gate-helper.mjs';

const SITE = 'ofluxo_site';
const DIR = 'docs/entregas/2026-11-14-fluxo-creator';
const SPEC = `${DIR}/specs/FC-009.md`;
const LOCAL_README = 'backend/deploy/creator-local/README.md';
const COMPOSE = 'backend/deploy/docker-compose.creator-local.yml';
const API_CLIENT = `${SITE}/src/platform/infrastructure/fluxo-api-client.ts`;
const MODULE_PAGE = `${SITE}/src/platform/presentation/pages/business/business-module-page.tsx`;
const SHELL = `${SITE}/src/platform/presentation/pages/business/business-shell.tsx`;
const WORKSPACE = `${SITE}/src/platform/domain/business-workspace.ts`;

/** Vitest do site (testes co-localizados, padrão do ofluxo_site) com relatório JSON; falha reprova, skip não conta. */
function siteVitest(file, minimum) {
  const bin = path.join(ROOT, SITE, 'node_modules/.bin/vitest');
  const report = path.join(ROOT, SITE, 'vitest-gate-report.json');
  const r = spawnSync(bin, ['run', file, '--reporter=json', `--outputFile=${report}`], {
    cwd: path.join(ROOT, SITE), encoding: 'utf8', timeout: 100_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CI: '1', NODE_ENV: 'test' },
  });
  assert.ok(r.status === 0 || exists(path.relative(ROOT, report)),
    `${file}: vitest saiu com ${r.status} e sem relatório:\n${(r.stderr ?? '').split('\n').slice(-20).join('\n')}`);
  assert.ok(exists(path.relative(ROOT, report)), `${file}: sem relatório JSON`);
  const json = JSON.parse(read(path.relative(ROOT, report)));
  const failures = json.testResults.flatMap((f) => f.assertionResults
    .filter((t) => t.status === 'failed')
    .map((t) => `${t.title}: ${String(t.failureMessages?.[0]).split('\n')[0].slice(0, 200)}`));
  assert.deepEqual(failures, [], `${file}: testes falharam`);
  assert.ok(json.numPassedTests >= minimum, `${file}: esperava ao menos ${minimum} testes verdes, houve ${json.numPassedTests}`);
}

const noRealIds = (text, file) => {
  for (const email of text.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/g) ?? [])
    assert.ok(email.endsWith('@example.test'), `${file}: e-mail fora do domínio reservado`);
  for (const hex of text.match(/\b[0-9a-f]{28,}\b/gi) ?? [])
    assert.ok(false, `${file}: literal longo demais parece identificador real: ${hex.slice(0, 8)}…`);
};

// ───────────────────────── contrato ─────────────────────────

test('FC-009 contrato: schemas zod da config, do kit e do projeto parseiam o wire e rejeitam payload quebrado', () => {
  const file = `${SITE}/src/platform/domain/creator-contracts.ts`;
  assert.ok(exists(file), `arquivo ausente: ${file}`);
  const src = read(file);
  assert.match(src, /from 'zod'/, 'contratos sem zod');
  for (const wire of ['copy_ready', 'creator_disabled', 'brandkit']) {
    assert.ok(src.includes(wire) || read(`${SITE}/src/platform/domain/creator-enums.ts`).includes(wire),
      `wire '${wire}' ausente dos contratos`);
  }
  siteVitest('src/platform/domain/creator-contracts.test.ts', 6);
});

// ───────────────────────── api ─────────────────────────

test('FC-009 api: cliente cobre config, kit, palette, projetos, copy, render e result com businessId em query', () => {
  const file = `${SITE}/src/platform/infrastructure/creator-api.ts`;
  assert.ok(exists(file), `arquivo ausente: ${file}`);
  const src = read(file);
  assert.match(src, /fluxoApi\.(getJson|putJson|postJson|getBlob)/, 'cliente não usa o fluxoApi');
  for (const rota of ['creator/config', 'creator/brand-kit', 'brand-kit/palette', 'creator/projects']) {
    assert.ok(src.includes(rota), `rota ausente no cliente: ${rota}`);
  }
  assert.match(src, /getBlob/, 'result do render precisa ir por getBlob (bytes do PNG)');
  siteVitest('src/platform/infrastructure/creator-api.test.ts', 6);
});

// ───────────────────────── prévia fiel ─────────────────────────

test('FC-009 previa: satori standalone + fontes do pacote + createSvgRenderer geram o SVG com os mesmos componentes do worker', () => {
  const file = `${SITE}/src/platform/infrastructure/creator-preview.ts`;
  assert.ok(exists(file), `arquivo ausente: ${file}`);
  const src = read(file);
  assert.match(src, /satori\/standalone/, 'prévia sem satori/standalone (medida precisa ser a do Satori)');
  assert.match(src, /createSvgRenderer/, 'prévia precisa usar o compositor de @fluxo/creator-render (mesma pipeline do render)');
  assert.match(src, /Exemplo SaaSSans-Regular|Exemplo SaaSSans/, 'fonte Exemplo SaaS Sans do pacote não carregada');
  assert.match(src, /Archivo-Bold/, 'peso 700 do Archivo não carregado');
  const pkg = JSON.parse(read(`${SITE}/package.json`));
  assert.ok(pkg.dependencies?.satori, 'satori precisa ser dependência do ofluxo_site');
  for (const config of [`${SITE}/vite.config.ts`, `${SITE}/vitest.config.ts`])
    assert.match(read(config), /@fluxo\/creator-render/, `${config}: alias do @fluxo/creator-render ausente`);
  assert.match(read(`${SITE}/tsconfig.app.json`), /@fluxo\/creator-render/, 'tsconfig sem paths do @fluxo/creator-render');
  siteVitest('src/platform/infrastructure/creator-preview.test.ts', 3);
});

// ───────────────────────── aba e visibilidade ─────────────────────────

test('FC-009 aba: moduleKeyFor creator, aba condicionada ao config 200, 404 silencioso e bypass dev-only do contexto', () => {
  const workspace = read(WORKSPACE);
  assert.match(stripComments(workspace) + workspace, /'creator'/, "business-workspace sem a chave 'creator' em moduleKeyFor/BusinessModuleKey");
  const modulePage = read(MODULE_PAGE);
  assert.match(modulePage, /case 'creator'/, 'business-module-page sem case do Creator');
  assert.match(modulePage, /creator_disabled|silencios|Navigate/, 'redirect silencioso do 404 ausente');
  assert.match(modulePage, /uiPreview|ui-preview/i, 'bypass de prévia de UI não usado no gate de contexto');
  const shell = read(SHELL);
  assert.match(shell, /creator/i, 'business-shell sem a aba condicional do Creator');
  assert.ok(exists(`${SITE}/src/platform/application/ui-preview.ts`), 'ui-preview.ts (regra dev-only compartilhada) ausente');
  siteVitest('src/platform/domain/business-workspace.test.ts', 4);
});

// ───────────────────────── dev-token ─────────────────────────

test('FC-009 dev-token: VITE_CREATOR_DEV_UID só vive atrás de import.meta.env.DEV e nunca sai para produção', () => {
  const src = read(API_CLIENT);
  assert.ok(src.includes('VITE_CREATOR_DEV_UID'), 'dev-token ausente no cliente da API');
  const guarded = src.match(/import\.meta\.env\.DEV[^;]*VITE_CREATOR_DEV_UID/s)
    ?? src.match(/VITE_CREATOR_DEV_UID[^;]*import\.meta\.env\.DEV/s);
  assert.ok(guarded, 'VITE_CREATOR_DEV_UID sem guarda de import.meta.env.DEV na mesma expressão');
  const envExample = read(`${SITE}/.env.example`);
  assert.match(envExample, /VITE_CREATOR_DEV_UID=/, '.env.example sem a variável documentada');
  const prod = stripComments(src);
  const loose = prod.match(/['"`]Bearer dev\./);
  if (loose) assert.ok(/import\.meta\.env\.DEV/.test(prod), 'Bearer dev. literal fora da branch de desenvolvimento');
  noRealIds(src, API_CLIENT);
});

// ───────────────────────── ambiente local (compose) ─────────────────────────

test('FC-009 compose: serviço site no compose local apontando para a API, CORS da 5173 e sem segredo do .env raiz', () => {
  assert.ok(exists(COMPOSE), `compose ausente: ${COMPOSE}`);
  const src = read(COMPOSE);
  assert.match(src, /^\s+site:\s*$/m, 'serviço site ausente no compose');
  assert.match(src, /CREATOR_LOCAL_SITE_PORT/, 'porta do site não configurável por CREATOR_LOCAL_SITE_PORT');
  assert.match(src, /127\.0\.0\.1:\$\{CREATOR_LOCAL_SITE_PORT/, 'porta do site precisa publicar só em 127.0.0.1');
  assert.match(src, /VITE_FLUXO_API_BASE_URL:\s*"http:\/\/127\.0\.0\.1:\$\{?CREATOR_LOCAL_API_PORT/, 'site sem a API local como base');
  assert.match(src, /VITE_CREATOR_DEV_UID:\s*"\$\{FLUXO_TEST_USER_UID/, 'dev-token do site não vem de FLUXO_TEST_USER_UID');
  assert.match(src, /VITE_UI_PREVIEW=\$?\{?FLUXO_LOCAL_SITE_PREVIEW|VITE_UI_PREVIEW:\s*"true"/, 'prévia de UI não ligada no serviço site');
  assert.match(src, /Cors__AllowedOrigins__2:\s*"http:\/\/127\.0\.0\.1:\$\{CREATOR_LOCAL_SITE_PORT/, 'CORS da API sem a origem do site');
  assert.match(src, /CREATOR_LLM_API_KEY:\s*"\$\{CREATOR_LLM_API_KEY:-\}"/, 'worker sem passthrough opcional do CREATOR_LLM_*');
  // Checa só linhas ativas do YAML: o header do compose explica que NÃO usa env_file (o .env raiz tem segredos).
  const active = src.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  for (const segredo of ['JIRA_', 'env_file:', 'DOPPLER_TOKEN']) assert.ok(!active.includes(segredo), `segredo ou env_file no compose: ${segredo}`);
  noRealIds(src, COMPOSE);
});

// ───────────────────────── regressão ─────────────────────────

test('FC-009 regressao: suite creator do site verde, typecheck do site e golden BIL-017 do workspace intacto', () => {
  siteVitest('src/platform/domain/creator-contracts.test.ts', 6);
  siteVitest('src/platform/infrastructure/creator-api.test.ts', 6);
  siteVitest('src/platform/infrastructure/creator-preview.test.ts', 3);
  siteVitest('src/platform/domain/creator-editor.test.ts', 3);
  const tsc = spawnSync(path.join(ROOT, SITE, 'node_modules/.bin/tsc'), ['-b'], {
    cwd: path.join(ROOT, SITE), encoding: 'utf8', timeout: 240_000, maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(tsc.status, 0, `typecheck do site falhou:\n${((tsc.stdout ?? '') + (tsc.stderr ?? '')).split('\n').slice(-25).join('\n')}`);
  const golden = spawnSync('node', ['--test', 'quality/test/delivery/bil-017.test.mjs'], {
    cwd: ROOT, encoding: 'utf8', timeout: 110_000, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(golden.status, 0, `golden do workspace (BIL-017) falhou com o módulo novo:\n${((golden.stdout ?? '') + (golden.stderr ?? '')).split('\n').slice(-25).join('\n')}`);
});

// ───────────────────────── documentação ─────────────────────────

test('FC-009 docs: spec ready, README do ambiente local com o front e nenhum identificador real', () => {
  assert.ok(exists(SPEC), `spec ausente: ${SPEC}`);
  const spec = read(SPEC);
  assert.match(spec, /Status: ready/, 'spec da FC-009 sem Status: ready');
  assert.match(spec, /FC-016|upload/i, 'spec sem registrar a decisão do upload fora do escopo');
  assert.ok(exists(LOCAL_README), `README local ausente: ${LOCAL_README}`);
  const localReadme = read(LOCAL_README);
  assert.match(localReadme, /5173/, 'README local sem a URL do front');
  for (const file of [SPEC, LOCAL_README, COMPOSE]) noRealIds(read(file), file);
});

