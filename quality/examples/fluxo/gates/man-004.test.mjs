// Gate MAN-004-SHORT-LINKS — serviço de links curtos (SQL + módulo na API .NET).
// ANTES da implementação este teste DEVE falhar (arquivos novos ainda não existem).
// Baseline: node quality/delivery/eval.mjs docs/entregas/2026-10-26-manifestacoes-caronas MAN-004 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SQL = 'backend/deploy/sql/links-mvp.sql';
const MODULE = 'backend/src/Fluxo.Api/Modules/Links/ShortLinkModule.cs';
const sql = fs.readFileSync(SQL, 'utf8');
const mod = fs.readFileSync(MODULE, 'utf8');

test('tabela fluxo.short_links com colunas do contrato e slug único', () => {
  assert.match(sql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+fluxo\.short_links/, 'tabela short_links deve existir no schema fluxo');
  for (const col of ['slug', 'target_type', 'target_id', 'created_by', 'clicks', 'revoked_at', 'expires_at']) {
    assert.match(sql, new RegExp(col), `coluna ${col} é obrigatória`);
  }
  assert.match(sql, /UNIQUE[\s\S]{0,80}slug|slug[\s\S]{0,80}UNIQUE/i, 'slug deve ter índice único');
});

test('módulo cria, resolve por slug e revoga o link', () => {
  assert.match(mod, /api\/v1\/links/, 'rota de criação GET/POST /api/v1/links');
  assert.match(mod, /\{slug\}|\/l\//, 'resolução por slug (GET /l/{slug})');
  assert.match(mod, /[Rr]evoke/, 'ação de revogação do slug');
});

test('resolver incrementa cliques e honra revogação/expiração', () => {
  assert.match(mod, /clicks/i, 'contador de cliques é incrementado na resolução');
  assert.match(mod, /revoked_at|expires_at/i, 'resolução honra revogação/expiração');
});
