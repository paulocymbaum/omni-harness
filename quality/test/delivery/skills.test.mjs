// Gate EG-SKILLS — verifica que as skills do ciclo de entrega existem e têm frontmatter
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

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

const SKILLS = [
  'entrega-em-ciclo',
  'implementar-tarefa',
  'documentar-entrega',
  'avaliar-qualidade',
];

for (const name of SKILLS) {
  test(`skill ${name}: SKILL.md existe com name e description`, () => {
    const p = path.join(ROOT, '.claude', 'skills', name, 'SKILL.md');
    assert.ok(fs.existsSync(p), `faltando: .claude/skills/${name}/SKILL.md`);
    const content = fs.readFileSync(p, 'utf8');
    const fm = parseFrontmatter(content);
    assert.ok(fm.name, `${name}/SKILL.md: frontmatter sem "name"`);
    assert.ok(fm.description, `${name}/SKILL.md: frontmatter sem "description"`);
  });
}

test('entrega-em-ciclo referencia os comandos CLI corretos', () => {
  const p = path.join(ROOT, '.claude', 'skills', 'entrega-em-ciclo', 'SKILL.md');
  const content = fs.readFileSync(p, 'utf8');
  assert.ok(content.includes('backlog.mjs'), 'deve referenciar backlog.mjs');
  assert.ok(content.includes('eval.mjs'), 'deve referenciar eval.mjs');
  assert.ok(content.includes('integridade.mjs'), 'deve referenciar integridade.mjs');
});

test('implementar-tarefa menciona baseline e mark done', () => {
  const p = path.join(ROOT, '.claude', 'skills', 'implementar-tarefa', 'SKILL.md');
  const content = fs.readFileSync(p, 'utf8');
  assert.ok(content.includes('--baseline'), 'deve mencionar --baseline');
  assert.ok(content.includes('--status done'), 'deve mencionar mark done');
});
