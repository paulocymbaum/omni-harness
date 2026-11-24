// Helper dos gates FC-001. Os templates xUnit (fc-dotnet/) são do autor de gates e só existem no projeto de testes durante a execução:
// nenhum teste do implementador serve como prova do contrato. Usam reflexão, HTTP e SQL, então compilam antes do módulo Creator
// existir e falham em execução. Integração sem ambiente (FLUXO_TEST_POSTGRES) FALHA, não pula.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, requireEnv } from './dv-002-dotnet-helper.mjs';

export { ROOT, requireEnv };

export const CREATOR_DIR = 'backend/src/Exemplo SaaS.Api/Modules/Creator';
const PROJECT = 'backend/tests/Exemplo SaaS.Api.Tests/Exemplo SaaS.Api.Tests.csproj';
const TEST_DIR = path.join(ROOT, 'backend/tests/Exemplo SaaS.Api.Tests');
const TEMPLATES = path.join(ROOT, 'quality/test/delivery/fc-dotnet');
const EXCLUDE_TARGETS = path.join(ROOT, 'quality/test/delivery/fc-dotnet/exclude-unrelated-broken-tests.targets');
const NS = 'Exemplo SaaS.Api.Tests';
const SUPPORT = 'GateFcSupport.cs';

export const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

export const read = (rel) => {
  assert.ok(exists(rel), `arquivo ausente: ${rel}`);
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
};

export function walk(rel, keep = () => true) {
  const out = [];
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['bin', 'obj', 'node_modules', '.dart_tool', 'build'].includes(entry.name)) continue;
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

function failureMessages(xml) {
  return [...xml.matchAll(/<UnitTestResult\b[^>]*testName="([^"]*)"[^>]*outcome="Failed"(?:(?!<\/UnitTestResult>)[\s\S])*?<Message>([\s\S]*?)<\/Message>/g)]
    .map(([, name, message]) => `${name.replace(`${NS}.`, '')}: ${message.split('\n').slice(0, 3).map((l) => l.trim()).join(' ').slice(0, 260)}`);
}

/**
 * Pré-condição estática: o módulo precisa existir antes de o dotnet ser chamado (falha pela razão certa, mesmo sem SDK).
 * Copia os templates, roda `dotnet test` e exige que cada teste nomeado seja descoberto e passe. Skip conta como falha.
 * classes: { Classe: ['Metodo', ...] }; postgres: exige FLUXO_TEST_POSTGRES.
 */
export function runDotnetGate(classes, { requiredFiles = [], postgres = false, existing = [], support = [], byMethod = false } = {}) {
  for (const file of requiredFiles) assert.ok(exists(file), `implementação ausente: ${file}`);
  if (postgres) requireEnv('FLUXO_TEST_POSTGRES', 'PostgreSQL 17 descartável com pgvector');
  const names = Object.keys(classes);
  const copies = [SUPPORT, ...support, ...names.map((c) => `${c}.cs`)];
  // byMethod: filtra só os métodos nomeados (gates de uma classe compartilhada não rodam os testes dos outros gates).
  const filter = [
    ...(byMethod
      ? Object.entries(classes).flatMap(([c, methods]) => methods.map((m) => `FullyQualifiedName~${NS}.${c}.${m}`))
      : names.map((c) => `FullyQualifiedName~${NS}.${c}.`)),
    ...existing.map((m) => `FullyQualifiedName~${NS}.${m}`),
  ].join('|');
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-trx-'));
  try {
    for (const file of copies) fs.copyFileSync(path.join(TEMPLATES, file), path.join(TEST_DIR, file));
    const r = spawnSync('dotnet', [
      'test', PROJECT, '--filter', filter, '--logger', 'trx;LogFileName=gate.trx',
      '--results-directory', resultsDir, '--nologo', `-p:CustomAfterMicrosoftCommonTargets=${EXCLUDE_TARGETS}`,
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
    assert.equal(r.status, 0, `dotnet test saiu com ${r.status}:\n${tail(output)}`);
  } finally {
    for (const file of copies) fs.rmSync(path.join(TEST_DIR, file), { force: true });
    fs.rmSync(resultsDir, { recursive: true, force: true });
  }
}
