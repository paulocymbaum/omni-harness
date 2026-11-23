// Gate EG-REFS — verifica que todos os arquivos referenciados pelo harness existem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

test('hooks .claude existem', () => {
  for (const h of [
    '.claude/hooks/lembrar-documentacao.mjs',
    '.claude/hooks/regras-de-dominio.mjs',
    '.claude/hooks/lib/regras.mjs',
  ]) assert.ok(fs.existsSync(path.join(ROOT, h)), `faltando: ${h}`);
});

test('hooks referenciados em settings.json existem', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8'));
  const re = /\$CLAUDE_PROJECT_DIR\/([\w./\-]+\.mjs)/g;
  for (const hookList of Object.values(settings.hooks ?? {})) {
    for (const entry of hookList) {
      for (const hook of entry.hooks ?? []) {
        for (const [, rel] of (hook.command ?? '').matchAll(re)) {
          assert.ok(fs.existsSync(path.join(ROOT, rel)), `hook em settings.json não existe: ${rel}`);
        }
      }
    }
  }
});

test('agentes .claude existem', () => {
  for (const a of [
    '.claude/agents/planejador.md',
    '.claude/agents/investigador-de-spec.md',
    '.claude/agents/documentador.md',
  ]) assert.ok(fs.existsSync(path.join(ROOT, a)), `faltando: ${a}`);
});

test('skills .claude existem (mínimo obrigatório)', () => {
  for (const s of [
    '.claude/skills/documentar-entrega/SKILL.md',
    '.claude/skills/entrega-em-ciclo/SKILL.md',
    '.claude/skills/avaliar-qualidade/SKILL.md',
  ]) assert.ok(fs.existsSync(path.join(ROOT, s)), `faltando: ${s}`);
});

test('AGENTS.md só referencia hooks que existem', () => {
  const src = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  const refs = [...src.matchAll(/\.claude\/hooks\/[\w/.-]+\.mjs/g)].map((m) => m[0]);
  for (const ref of refs) {
    assert.ok(fs.existsSync(path.join(ROOT, ref)), `AGENTS.md cita hook inexistente: ${ref}`);
  }
});

test('CLAUDE.md só referencia arquivos que existem', () => {
  const clmdPath = path.join(ROOT, 'CLAUDE.md');
  if (!fs.existsSync(clmdPath)) return; // arquivo opcional
  const src = fs.readFileSync(clmdPath, 'utf8');
  // Extrai caminhos relativos entre backticks que parecem .mjs
  const refs = [...src.matchAll(/`([\w./\-]+\.mjs)`/g)].map((m) => m[1]);
  for (const ref of refs) {
    assert.ok(fs.existsSync(path.join(ROOT, ref)), `CLAUDE.md cita arquivo inexistente: ${ref}`);
  }
});
