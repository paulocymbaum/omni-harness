// Helper comum dos gates dotnet do exemplo de hospedeiro (DV/BIL/FC): um só runDotnetGate,
// parseTrx, walk e leitura de arquivo — as cópias derivadas (bil-gate-helper, fc-001-gate-helper,
// dv-002-dotnet-helper) viram wrappers finos que só fixam a família (templates, suporte, exclusões,
// prefixo de TRX). Os templates xUnit são do autor de gates e só existem no projeto de testes
// durante a execução: nenhum teste ou marcador do implementador serve como prova do contrato (DV-005).
// Integração sem ambiente (FLUXO_TEST_POSTGRES / FIRESTORE_EMULATOR_HOST) FALHA, não pula (PF-001).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const NS_PADRAO = 'Exemplo SaaS.Api.Tests';
const TEST_DIR = path.join(ROOT, 'backend/tests/Exemplo SaaS.Api.Tests');
const PROJECT = 'backend/tests/Exemplo SaaS.Api.Tests/Exemplo SaaS.Api.Tests.csproj';

export function requireEnv(name, why) {
  assert.ok(
    typeof process.env[name] === 'string' && process.env[name].trim() !== '',
    `${name} não configurado (${why}); o gate falha em vez de pular`,
  );
}

export const tailOf = (text, lines = 60) => text.split('\n').slice(-lines).join('\n');

export const existsRel = (root, rel) => fs.existsSync(path.join(root, rel));

export function readFileRel(root, rel) {
  assert.ok(existsRel(root, rel), `arquivo ausente: ${rel}`);
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

/**
 * Lista arquivos sob `rel` (caminhos POSIX relativos à `root`). Diretório ausente devolve [].
 * `exclude` pula pastas geradas; os wrappers dos gates fixam a lista de cada família.
 */
export function walkRel(root, rel, keep = () => true, { exclude = ['bin', 'obj', 'node_modules', '.dart_tool', 'build'] } = {}) {
  const out = [];
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (exclude.includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  visit(path.join(root, rel));
  return out.filter(keep);
}

/** Resultados de um TRX: { name (decodificado), outcome } por UnitTestResult; sem name, ignora. */
export function parseTrx(xml) {
  const decode = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const results = [];
  for (const [tag] of xml.matchAll(/<UnitTestResult\b[^>]*>/g)) {
    const m = tag.match(/\btestName="([^"]*)"/);
    const o = tag.match(/\boutcome="([^"]*)"/);
    if (m) results.push({ name: decode(m[1]), outcome: o ? o[1] : 'Unknown' });
  }
  return results;
}

/** Mensagens de falha do TRX, para o gate dizer por que falhou (e não só que falhou). */
export function trxFailureMessages(xml, ns = NS_PADRAO) {
  return [...xml.matchAll(/<UnitTestResult\b[^>]*testName="([^"]*)"[^>]*outcome="Failed"(?:(?!<\/UnitTestResult>)[\s\S])*?<Message>([\s\S]*?)<\/Message>/g)]
    .map(([, name, message]) => `${name.replace(`${ns}.`, '')}: ${message.split('\n').slice(0, 3).map((l) => l.trim()).join(' ').slice(0, 260)}`);
}

const names = (classes) => Object.keys(classes);

/** Filtro --filter do dotnet test: por método (byMethod) ou por classe + existentes + prefixo do implementador. */
function filtroDotnet(classes, { ns, byMethod, existing, implementerPrefix }) {
  return [
    ...(byMethod
      ? Object.entries(classes).flatMap(([c, methods]) => methods.map((m) => `FullyQualifiedName~${ns}.${c}.${m}`))
      : names(classes).map((c) => `FullyQualifiedName~${ns}.${c}.`)),
    ...existing.map((m) => `FullyQualifiedName~${ns}.${m}`),
    ...(implementerPrefix ? [`FullyQualifiedName~${ns}.${implementerPrefix}`] : []),
  ].join('|');
}

/** Fábrica do runDotnetGate de uma família (BIL/FC): o helper exporta o wrapper já configurado. */
export function makeDotnetGate(familia) {
  return (classes, opts = {}) => runDotnetGateCommon(classes, { ...familia, ...opts });
}

/** Exige: nada pulado, todos descobertos, nenhum Failed, prefixo do implementador executado. */
function exigirVerdes(results, xml, { classes, ns, existing, implementerPrefix }, output) {
  assert.deepEqual(results.filter((t) => !['Passed', 'Failed'].includes(t.outcome)).map((t) => `${t.name} (${t.outcome})`), [],
    'teste pulado não conta como evidência');
  const required = [
    ...Object.entries(classes).flatMap(([c, methods]) => methods.map((m) => `${ns}.${c}.${m}`)),
    ...existing.map((m) => `${ns}.${m}`),
  ];
  const missing = required.filter((n) => !results.some((t) => t.name === n || t.name.startsWith(`${n}(`)));
  assert.deepEqual(missing, [], 'testes requeridos não descobertos');
  assert.deepEqual(trxFailureMessages(xml, ns), [], `testes falharam:\n${output}`);
  assert.deepEqual(results.filter((t) => t.outcome === 'Failed').map((t) => t.name), [], 'testes falharam');
  if (implementerPrefix) {
    assert.ok(results.some((t) => t.name.startsWith(`${ns}.${implementerPrefix}`)),
      `nenhum teste ${implementerPrefix}* do implementador foi executado`);
  }
}

/** Spawn do `dotnet test` com o filter montado; devolve xml do TRX, status e saída (falha cedo sem TRX). */
function rodarDotnetTest({ root, excludeTargets, excludeBroken, filter, resultsDir }) {
  const r = spawnSync('dotnet', [
    'test', PROJECT, '--filter', filter, '--logger', 'trx;LogFileName=gate.trx',
    '--results-directory', resultsDir, '--nologo', ...(excludeBroken ? [`-p:CustomAfterMicrosoftCommonTargets=${excludeTargets}`] : []),
  ], { cwd: root, encoding: 'utf8', timeout: 115_000, maxBuffer: 16 * 1024 * 1024 });
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  assert.equal(r.error, undefined, `dotnet test não executou (${r.error?.message}):\n${tailOf(output)}`);
  const trx = path.join(resultsDir, 'gate.trx');
  assert.ok(fs.existsSync(trx), `nenhum TRX gerado; build falhou ou nada foi descoberto:\n${tailOf(output)}`);
  return { status: r.status, xml: fs.readFileSync(trx, 'utf8'), output };
}

/**
 * Copia os templates do gate, roda `dotnet test` e exige que cada teste nomeado seja descoberto
 * e passe. Skip conta como falha. classes: { Classe: ['Metodo', ...] }. Família por options:
 * templatesDir/excludeTargets/supportFile/trxPrefix (obrigatórios) + requiredFiles (pré-condição
 * estática FC), postgres (exige FLUXO_TEST_POSTGRES — BIL sempre, FC quando pedido), existing
 * (testes já verdes que continuam exigidos), implementerPrefix (testes `<prefixo>*` do
 * implementador, BIL), support (templates de apoio), byMethod (filtra só métodos nomeados, FC),
 * excludeBroken (mantém a exclusão de testes quebrados não relacionados; BIL-007+ passa false).
 */
// Superfície externa é o makeDotnetGate; este runner fica interno ao módulo.
function runDotnetGateCommon(classes, {
  root, templatesDir, excludeTargets, supportFile, trxPrefix,
  ns = NS_PADRAO, requiredFiles = [], postgres = false, existing = [],
  implementerPrefix = null, support = [], byMethod = false, excludeBroken = true,
} = {}) {
  for (const file of requiredFiles) assert.ok(existsRel(root, file), `implementação ausente: ${file}`);
  if (postgres) requireEnv('FLUXO_TEST_POSTGRES', 'PostgreSQL 17 descartável com pgvector');
  const copies = [supportFile, ...support, ...names(classes).map((c) => `${c}.cs`)];
  const filter = filtroDotnet(classes, { ns, byMethod, existing, implementerPrefix });
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), `${trxPrefix}-trx-`));
  try {
    for (const file of copies) fs.copyFileSync(path.join(templatesDir, file), path.join(TEST_DIR, file));
    const { status, xml, output } = rodarDotnetTest({ root, excludeTargets, excludeBroken, filter, resultsDir });
    exigirVerdes(parseTrx(xml), xml, { classes, ns, existing, implementerPrefix }, tailOf(output));
    assert.equal(status, 0, `dotnet test saiu com ${status}:\n${tailOf(output)}`);
  } finally {
    for (const file of copies) fs.rmSync(path.join(TEST_DIR, file), { force: true });
    fs.rmSync(resultsDir, { recursive: true, force: true });
  }
}

