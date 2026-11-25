// Helper dos gates DV-006: roda Vitest no admin-web e lê o relatório JSON.
// Dois modos:
//   - runGateSpecs: copia specs do próprio gate (quality/test/delivery/dv-006-vitest/*.vitest.ts[x]) para uma pasta
//     temporária em admin-web/src/, roda e apaga. O implementador não pode enfraquecer essas asserções.
//   - runNamedCases: exige que testes nomeados escritos pelo implementador existam, rodem e passem
//     (ausente, pulado ou "todo" conta como falha; padrão de pf-flutter-gate-helper.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const ADMIN = path.join(ROOT, 'admin-web');
const TEMPLATES = path.join(ROOT, 'quality/test/delivery/dv-006-vitest');
const GATE_DIR_PREFIX = '__dv006_gate_';

function runVitest(relFiles) {
  const bin = path.join(ADMIN, 'node_modules/.bin/vitest');
  assert.ok(fs.existsSync(bin), 'admin-web/node_modules/.bin/vitest ausente: rode npm --prefix admin-web ci');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv006-vitest-'));
  const outFile = path.join(outDir, 'report.json');
  try {
    const r = spawnSync(bin, ['run', ...relFiles, '--reporter=json', `--outputFile=${outFile}`], {
      cwd: ADMIN,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test', CI: '1' },
      timeout: 110_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    assert.equal(r.error, undefined, `vitest não executou (${r.error?.message}):\n${tail(output)}`);
    assert.ok(fs.existsSync(outFile), `vitest não gerou relatório JSON:\n${tail(output)}`);
    const report = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    const files = (report.testResults ?? []).map((f) => ({
      file: path.relative(ADMIN, f.name).split(path.sep).join('/'),
      status: f.status,
      message: f.message ?? '',
      cases: (f.assertionResults ?? []).map((a) => ({
        title: a.title,
        fullName: a.fullName,
        status: a.status,
        failure: (a.failureMessages ?? []).join('\n').slice(0, 1500),
      })),
    }));
    return { files, output };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

function describeFailures(files) {
  return files
    .map((f) => [
      `${f.file} [${f.status}] ${f.message.slice(0, 1500)}`,
      ...f.cases.filter((c) => c.status !== 'passed').map((c) => `  - ${c.title} [${c.status}] ${c.failure}`),
    ].join('\n'))
    .join('\n');
}

/**
 * Copia os templates do gate para admin-web/src/__dv006_gate_<pid>__/ e exige que todos os casos
 * (contados no template) rodem e passem. `replace` troca marcadores no texto do template.
 */
export function runGateSpecs(templates, replace = {}) {
  const dirName = `${GATE_DIR_PREFIX}${process.pid}__`;
  const dir = path.join(ADMIN, 'src', dirName);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const expected = new Map();
    for (const template of templates) {
      let text = fs.readFileSync(path.join(TEMPLATES, template), 'utf8');
      for (const [marker, value] of Object.entries(replace)) text = text.split(marker).join(value);
      const target = template.replace(/\.vitest\.(tsx?)$/, '.test.$1');
      fs.writeFileSync(path.join(dir, target), text);
      expected.set(`src/${dirName}/${target}`, (text.match(/^\s*it\(/gm) ?? []).length);
    }
    const { files, output } = runVitest([...expected.keys()]);
    for (const [rel, count] of expected) {
      const f = files.find((x) => x.file === rel);
      assert.ok(f, `vitest não executou ${rel}:\n${tail(output)}`);
      const passed = f.cases.filter((c) => c.status === 'passed').length;
      assert.ok(
        count > 0 && passed === count && f.cases.length === count,
        `${rel}: ${passed}/${count} casos passaram\n${describeFailures([f])}`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * casesByFile: { 'src/modules/debates/...test.tsx': ['título exato', ...] }.
 * Cada título precisa existir e passar; o arquivo inteiro também precisa passar.
 */
export function runNamedCases(casesByFile) {
  const rels = Object.keys(casesByFile);
  const missingFiles = rels.filter((rel) => !fs.existsSync(path.join(ADMIN, rel)));
  assert.deepEqual(missingFiles, [], 'arquivos de teste do admin-web exigidos pelo gate não existem');
  const { files, output } = runVitest(rels);
  const problems = [];
  for (const [rel, titles] of Object.entries(casesByFile)) {
    const f = files.find((x) => x.file === rel);
    if (!f) {
      problems.push(`${rel}: não executado`);
      continue;
    }
    if (f.status !== 'passed') problems.push(describeFailures([f]));
    for (const title of titles) {
      const c = f.cases.find((x) => x.title === title);
      if (!c) problems.push(`${rel}: caso ausente "${title}"`);
      else if (c.status !== 'passed') problems.push(`${rel}: "${title}" [${c.status}]`);
    }
  }
  assert.deepEqual(problems, [], `casos Vitest exigidos não passaram:\n${tail(output)}`);
}

/** Lista arquivos .ts/.tsx de um diretório (recursivo), ignorando pastas temporárias do gate. */
export function sourceFiles(dir, { includeTests = false } = {}) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(GATE_DIR_PREFIX) || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full, { includeTests }));
    else if (/\.tsx?$/.test(entry.name) && (includeTests || !/\.(test|spec)\.tsx?$/.test(entry.name))) out.push(full);
  }
  return out;
}

function tail(text, max = 4000) {
  return text.length > max ? `…${text.slice(-max)}` : text;
}
