// Gate EG-AGENTES — verifica que os agentes do ciclo de entrega existem e têm frontmatter válido
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

const AGENTS = [
  'investigador-de-spec',
  'implementador',
  'avaliador-de-entrega',
  'planejador',
  'documentador',
];

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const result = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (kv) result[kv[1]] = kv[2].trim();
  }
  return result;
}

for (const name of AGENTS) {
  test(`agente ${name} existe e tem frontmatter name/description`, () => {
    const p = path.join(ROOT, '.claude', 'agents', `${name}.md`);
    assert.ok(fs.existsSync(p), `faltando: .claude/agents/${name}.md`);
    const content = fs.readFileSync(p, 'utf8');
    const fm = parseFrontmatter(content);
    assert.ok(fm.name, `${name}.md: frontmatter sem "name"`);
    assert.ok(fm.description, `${name}.md: frontmatter sem "description"`);
    assert.equal(fm.name, name, `${name}.md: name no frontmatter deve ser "${name}"`);
  });
}

test('implementador referencia comandos CLI que existem', () => {
  const p = path.join(ROOT, '.claude', 'agents', 'implementador.md');
  const content = fs.readFileSync(p, 'utf8');
  assert.ok(content.includes('backlog.mjs'), 'implementador deve referenciar backlog.mjs');
  assert.ok(content.includes('eval.mjs'), 'implementador deve referenciar eval.mjs');
});
