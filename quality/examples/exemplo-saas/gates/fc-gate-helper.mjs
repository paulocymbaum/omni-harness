// Helper compartilhado dos gates FC-002 em diante. NÃO repete o que fc-001-gate-helper.mjs já faz (runDotnetGate, read,
// exists, walk): reexporta e acrescenta só o que faltava: leitura de enums (C# e TS), varredura sem comentários, Vitest
// em pacote próprio (com npm ci, falhando em vez de pular) e Vitest do ofluxo_site com templates de fc-web/.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runVitestTemplates } from './bil-gate-helper.mjs';
import { CREATOR_DIR, ROOT, exists, read, walk } from './fc-001-gate-helper.mjs';

export * from './fc-001-gate-helper.mjs';

export const CS_ENUMS = `${CREATOR_DIR}/Domain/CreatorEnums.cs`;
export const TS_ENUMS = 'ofluxo_site/src/platform/domain/creator-enums.ts';
export const APPSETTINGS = 'backend/src/Exemplo SaaS.Api/appsettings.json';

export const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/.*$/gm, '$1');
const norm = (s) => s.replace(/[_.]/g, '').toLowerCase();
export const sameWire = (cs, wire) => norm(cs) === norm(wire) || `creator${norm(cs)}` === norm(wire);

export function csEnumNames(src, name, file = CS_ENUMS) {
  const m = src.match(new RegExp(`enum\\s+${name}\\b[^{]*\\{([^}]*)\\}`));
  assert.ok(m, `enum ${name} ausente em ${file}`);
  return stripComments(m[1]).split(',').map((s) => s.trim().split(/[\s=]/)[0]).filter(Boolean);
}

/** Aceita `export const X = [...] as const` e `export type X = 'a' | 'b'` (estilo do debate-worker). */
export function tsEnumValues(src, name, file = TS_ENUMS) {
  const arr = src.match(new RegExp(`export\\s+const\\s+${name}\\s*(?::[^=]+)?=\\s*\\[([^\\]]*)\\]`));
  const union = src.match(new RegExp(`export\\s+type\\s+${name}\\s*=\\s*([^;]+);`));
  assert.ok(arr || union, `${name} ausente em ${file}`);
  return [...(arr ? arr[1] : union[1]).matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
}

/** Folhas (valores escalares) de um JSON, inclusive dentro de arrays. */
export function leaves(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => leaves(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => leaves(v, out));
  else out.push(value);
  return out;
}

/** Todos os caminhos de chave (a.b.c) de um objeto JSON. */
export function keyPaths(value, prefix = '', out = []) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) {
      out.push(prefix ? `${prefix}.${k}` : k);
      keyPaths(v, prefix ? `${prefix}.${k}` : k, out);
    }
  }
  return out;
}

/** Valida enums C# + TS + CANONICAL_ENUMS (assert dos três lados) para o mapa { Nome: [wire...] }. */
export async function assertEnumsEverywhere(wire, { csFile = CS_ENUMS, tsFile = TS_ENUMS, requireTs = true } = {}) {
  const { pathToFileURL } = await import('node:url');
  const cs = read(csFile);
  const ts = requireTs ? read(tsFile) : '';
  const { CANONICAL_ENUMS } = await import(pathToFileURL(path.join(ROOT, '.claude/hooks/lib/regras.mjs')).href);
  for (const [name, values] of Object.entries(wire)) {
    const csNames = csEnumNames(cs, name, csFile);
    assert.equal(csNames.length, values.length, `${name} C#: esperava ${values.length} valores, houve ${csNames.length}`);
    assert.deepEqual(values.filter((w) => csNames.some((n) => sameWire(n, w))), values, `${name} C#: valores divergem do wire`);
    if (requireTs) assert.deepEqual([...tsEnumValues(ts, name, tsFile)].sort(), [...values].sort(), `${name} TS: valores divergem do wire`);
    assert.ok(CANONICAL_ENUMS[name], `CANONICAL_ENUMS sem ${name}`);
    assert.ok(CANONICAL_ENUMS[name].includes(csFile), `${name} sem ${csFile} em CANONICAL_ENUMS`);
    if (requireTs) assert.ok(CANONICAL_ENUMS[name].includes(tsFile), `${name} sem ${tsFile} em CANONICAL_ENUMS`);
  }
  const def = new RegExp(`\\b(?:enum|class|type|interface)\\s+(${Object.keys(wire).join('|')})\\b`);
  const offenders = [...walk('lib', (f) => f.endsWith('.dart')), ...walk('functions/src', (f) => f.endsWith('.ts'))]
    .filter((f) => def.test(read(f)));
  assert.deepEqual(offenders, [], 'enums redefinidas no Flutter ou nas Functions');
}

const tail = (text, lines = 40) => text.split('\n').slice(-lines).join('\n');

/** Vitest do ofluxo_site com templates de quality/test/delivery/fc-web/ (copiados só durante o gate). */
export function runWebVitest(templates, minimum, opts = {}) {
  runVitestTemplates('ofluxo_site', templates, minimum, { ...opts, templatesDir: 'fc-web' });
}

/**
 * Garante node_modules de um pacote npm local (package-lock próprio, sem workspace raiz) e FALHA, não pula, se não
 * der para instalar. Nunca toca em outro pacote (ex.: services/debate-worker).
 */
export function ensurePackageInstalled(dir) {
  assert.ok(exists(`${dir}/package.json`), `pacote ausente: ${dir}/package.json`);
  assert.ok(exists(`${dir}/package-lock.json`), `${dir} sem package-lock.json (npm ci exige o lockfile local)`);
  const nodeModules = path.join(ROOT, dir, 'node_modules');
  if (fs.existsSync(path.join(nodeModules, '.bin', 'vitest'))) return;
  const r = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: path.join(ROOT, dir), encoding: 'utf8', timeout: 110_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(r.error, undefined, `npm ci não executou em ${dir}: ${r.error?.message}`);
  assert.equal(r.status, 0, `npm ci falhou em ${dir}:\n${tail(`${r.stdout}\n${r.stderr}`)}`);
  assert.ok(fs.existsSync(path.join(nodeModules, '.bin', 'vitest')), `${dir}: vitest ausente depois do npm ci`);
}

/**
 * Roda templates Vitest de quality/test/delivery/<templatesDir>/ DENTRO do pacote (destino relativo ao pacote).
 * Exige ao menos `minimum` testes verdes; teste pulado ou falhando reprova.
 */
export function runPackageVitest(dir, templatesDir, templates, minimum, opts = {}) {
  ensurePackageInstalled(dir);
  runVitestTemplates(dir, templates, minimum, { ...opts, templatesDir });
}

export { CREATOR_DIR, ROOT, exists, read, walk };
