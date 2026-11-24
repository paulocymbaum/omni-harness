// Helper dos gates BIL-*. Os templates xUnit são do autor de gates e só existem no projeto de testes durante a execução:
// nenhum teste ou marcador do implementador serve como prova do contrato (padrão DV-005).
// Os templates usam HTTP, SQL e reflexão para Billing, então compilam antes da implementação e falham em execução.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, requireEnv, runOk } from './dv-002-dotnet-helper.mjs';

export { ROOT, requireEnv, runOk };

export const DELIVERY = 'docs/entregas/2026-10-31-billing-asaas-mercadopago';
export const BILLING_DIR = 'backend/src/Exemplo SaaS.Api/Modules/Billing';
const PROJECT = 'backend/tests/Exemplo SaaS.Api.Tests/Exemplo SaaS.Api.Tests.csproj';
const TEST_DIR = path.join(ROOT, 'backend/tests/Exemplo SaaS.Api.Tests');
const TEMPLATES = path.join(ROOT, 'quality/test/delivery/bil-dotnet');
const EXCLUDE_TARGETS = path.join(TEMPLATES, 'exclude-unrelated-broken-test.targets');
const NS = 'Exemplo SaaS.Api.Tests';
const SUPPORT = 'GateBilSupport.cs';

export const read = (rel) => {
  const file = path.join(ROOT, rel);
  assert.ok(fs.existsSync(file), `arquivo ausente: ${rel}`);
  return fs.readFileSync(file, 'utf8');
};

export const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/** Lista arquivos sob `rel` (caminhos POSIX relativos à raiz). Diretório ausente devolve []. */
export function walk(rel, keep = () => true) {
  const out = [];
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['bin', 'obj', 'node_modules'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else out.push(path.relative(ROOT, full).split(path.sep).join('/'));
    }
  };
  visit(path.join(ROOT, rel));
  return out.filter(keep);
}

const tail = (text, lines = 60) => text.split('\n').slice(-lines).join('\n');

function parseTrx(xml) {
  const decode = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const results = [];
  for (const [tag] of xml.matchAll(/<UnitTestResult\b[^>]*>/g)) {
    const name = tag.match(/\btestName="([^"]*)"/)?.[1];
    if (name) results.push({ name: decode(name), outcome: tag.match(/\boutcome="([^"]*)"/)?.[1] ?? 'Unknown' });
  }
  return results;
}

/** Mensagens de falha do TRX, para o gate dizer por que falhou (e não só que falhou). */
function failureMessages(xml) {
  return [...xml.matchAll(/<UnitTestResult\b[^>]*testName="([^"]*)"[^>]*outcome="Failed"(?:(?!<\/UnitTestResult>)[\s\S])*?<Message>([\s\S]*?)<\/Message>/g)]
    .map(([, name, message]) => `${name.replace(`${NS}.`, '')}: ${message.split('\n').slice(0, 3).map((l) => l.trim()).join(' ').slice(0, 260)}`);
}

/**
 * Copia os templates, roda `dotnet test` e exige que cada teste nomeado seja descoberto e passe. Skip conta como falha.
 * classes: { Classe: ['Metodo', ...] } — templates do gate, um arquivo <Classe>.cs em bil-dotnet/.
 * existing: ['Classe.Metodo', ...] — testes já existentes que precisam continuar verdes.
 * implementerPrefix: exige também os testes `<prefixo>*` do implementador (ao menos um, todos verdes).
 * support: templates de apoio além de GateBilSupport.cs.
 * excludeBroken: mantém a exclusão de Mobility/GtfsStaticFeedTests.cs. Gates a partir de BIL-007 passam false: o teste compila.
 */
export function runDotnetGate(classes, { existing = [], implementerPrefix = null, support = [], excludeBroken = true } = {}) {
  requireEnv('FLUXO_TEST_POSTGRES', 'PostgreSQL 17 descartável com pgvector');
  const names = Object.keys(classes);
  const copies = [SUPPORT, ...support, ...names.map((c) => `${c}.cs`)];
  const filter = [
    ...names.map((c) => `FullyQualifiedName~${NS}.${c}.`),
    ...existing.map((m) => `FullyQualifiedName~${NS}.${m}`),
    ...(implementerPrefix ? [`FullyQualifiedName~${NS}.${implementerPrefix}`] : []),
  ].join('|');
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bil-trx-'));
  try {
    for (const file of copies) fs.copyFileSync(path.join(TEMPLATES, file), path.join(TEST_DIR, file));
    const r = spawnSync('dotnet', [
      'test', PROJECT, '--filter', filter, '--logger', 'trx;LogFileName=gate.trx',
      '--results-directory', resultsDir, '--nologo', ...(excludeBroken ? [`-p:CustomAfterMicrosoftCommonTargets=${EXCLUDE_TARGETS}`] : []),
    ], { cwd: ROOT, encoding: 'utf8', timeout: 115_000, maxBuffer: 16 * 1024 * 1024 });
    const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    assert.equal(r.error, undefined, `dotnet test não executou (${r.error?.message}):\n${tail(output)}`);
    const trx = path.join(resultsDir, 'gate.trx');
    assert.ok(fs.existsSync(trx), `nenhum TRX gerado; build falhou ou nada foi descoberto:\n${tail(output)}`);
    const xml = fs.readFileSync(trx, 'utf8');
    const results = parseTrx(xml);
    assert.deepEqual(results.filter((t) => !['Passed', 'Failed'].includes(t.outcome)).map((t) => `${t.name} (${t.outcome})`), [],
      'teste pulado não conta como evidência');
    const required = [
      ...Object.entries(classes).flatMap(([c, methods]) => methods.map((m) => `${NS}.${c}.${m}`)),
      ...existing.map((m) => `${NS}.${m}`),
    ];
    const missing = required.filter((n) => !results.some((t) => t.name === n || t.name.startsWith(`${n}(`)));
    assert.deepEqual(missing, [], 'testes requeridos não descobertos');
    assert.deepEqual(failureMessages(xml), [], 'testes falharam');
    assert.deepEqual(results.filter((t) => t.outcome === 'Failed').map((t) => t.name), [], 'testes falharam');
    if (implementerPrefix) {
      assert.ok(results.some((t) => t.name.startsWith(`${NS}.${implementerPrefix}`)),
        `nenhum teste ${implementerPrefix}* do implementador foi executado`);
    }
    assert.equal(r.status, 0, `dotnet test saiu com ${r.status}:\n${tail(output)}`);
  } finally {
    for (const file of copies) fs.rmSync(path.join(TEST_DIR, file), { force: true });
    fs.rmSync(resultsDir, { recursive: true, force: true });
  }
}

/** Roda um arquivo Vitest do admin-web e exige ao menos `minimum` testes verdes. */
export function runAdminVitest(rel, minimum) {
  assert.ok(exists(`admin-web/${rel}`), `teste ausente: admin-web/${rel}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bil-vitest-'));
  const report = path.join(dir, 'report.json');
  try {
    const r = spawnSync(path.join(ROOT, 'admin-web/node_modules/.bin/vitest'), [
      'run', rel, '--reporter=json', `--outputFile=${report}`,
    ], { cwd: path.join(ROOT, 'admin-web'), encoding: 'utf8', timeout: 100_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CI: '1', NODE_ENV: 'test' } });
    assert.equal(r.error, undefined, `Vitest não executou: ${r.error?.message}`);
    assert.ok(fs.existsSync(report), `Vitest não produziu relatório:\n${tail(`${r.stdout}\n${r.stderr}`)}`);
    const json = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.equal(json.numFailedTests, 0, 'há teste Vitest falhando');
    assert.equal(json.numPendingTests ?? 0, 0, 'teste Vitest pulado não conta como evidência');
    assert.ok(json.numPassedTests >= minimum, `esperava ao menos ${minimum} testes verdes, houve ${json.numPassedTests}`);
    assert.equal(r.status, 0, `Vitest saiu com ${r.status}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Copia templates Vitest do autor de gates para dentro do app, roda só eles e remove. Prova contra o contrato, não contra o
 * teste do implementador. templates: { 'arquivo em bil-web/': 'destino relativo ao app' }. Exige ao menos `minimum` verdes.
 */
export function runVitestTemplates(app, templates, minimum, { only = null, templatesDir = 'bil-web' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bil-web-'));
  const report = path.join(dir, 'report.json');
  const copies = Object.entries(templates).map(([file, dest]) => [path.join(ROOT, 'quality/test/delivery', templatesDir, file), path.join(ROOT, app, dest), dest]);
  try {
    for (const [from, to, dest] of copies) {
      assert.ok(fs.existsSync(path.dirname(to)), `diretório ausente para o template: ${path.dirname(dest)}`);
      fs.copyFileSync(from, to);
    }
    const r = spawnSync(path.join(ROOT, app, 'node_modules/.bin/vitest'), [
      'run', ...copies.map(([, , dest]) => dest), ...(only ? ['-t', only] : []), '--reporter=json', `--outputFile=${report}`,
    ], { cwd: path.join(ROOT, app), encoding: 'utf8', timeout: 100_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, CI: '1', NODE_ENV: 'test' } });
    assert.equal(r.error, undefined, `Vitest não executou: ${r.error?.message}`);
    assert.ok(fs.existsSync(report), `Vitest não produziu relatório:\n${tail(`${r.stdout}\n${r.stderr}`)}`);
    const json = JSON.parse(fs.readFileSync(report, 'utf8'));
    const failures = json.testResults.flatMap((file) => [
      ...(file.status === 'failed' && !file.assertionResults.length ? [`${path.basename(file.name)}: ${String(file.message).split('\n')[0].slice(0, 200)}`] : []),
      ...file.assertionResults.filter((t) => t.status === 'failed').map((t) => `${t.title}: ${String(t.failureMessages?.[0]).split('\n')[0].slice(0, 200)}`),
    ]);
    assert.deepEqual(failures, [], 'testes Vitest do gate falharam');
    if (!only) assert.equal(json.numPendingTests ?? 0, 0, 'teste Vitest pulado não conta como evidência');
    assert.ok(json.numPassedTests >= minimum, `esperava ao menos ${minimum} testes verdes, houve ${json.numPassedTests}`);
    assert.equal(r.status, 0, `Vitest saiu com ${r.status}`);
  } finally {
    for (const [, to] of copies) fs.rmSync(to, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
