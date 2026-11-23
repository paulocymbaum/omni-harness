// Gate MAN-014-DOCS — documentação canônica e relatório da entrega.
// ANTES da implementação este teste DEVE falhar (documentos ainda não existem).
// Baseline: node quality/delivery/eval.mjs docs/entregas/2026-10-26-manifestacoes-caronas MAN-014 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const DOMAIN_DOC = 'docs/eventos/manifestacoes.md';
const REPORT = 'docs/entregas/2026-10-26-manifestacoes-caronas/entrega.md';
const domain = fs.readFileSync(DOMAIN_DOC, 'utf8');
const report = fs.readFileSync(REPORT, 'utf8');

test('docs/eventos/manifestacoes.md documenta o domínio completo', () => {
  assert.match(domain, /manifestation/, 'tipo manifestation documentado');
  assert.match(domain, /presença|presence/i, 'presença geo-confirmada documentada');
  assert.match(domain, /[Cc]arona/, 'carona solidária documentada');
  assert.match(domain, /[Mm]ateriais/, 'materiais documentados');
  assert.match(domain, /[Ll]ink/, 'link curto documentado');
});

test('entrega.md reúne o relatório da entrega com gates', () => {
  assert.match(report, /##\s/, 'relatório com seções');
  assert.match(report, /[Gg]ate/, 'relatório de gates presente (item 7 do formato)');
  assert.match(report, /[Rr]isco/, 'riscos documentados');
});
