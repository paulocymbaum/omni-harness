// Gate CFR-001 — aviso de carona excluída pelo motorista (detalhes da rota).
// ANTES da implementação este teste DEVE falhar (rodar da raiz do repo).
// Baseline: node quality/delivery/eval.mjs docs/entregas/2026-10-26-caronas-followup CFR-001 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const domainPagesPath = 'ofluxo_site/src/platform/presentation/pages/domain-pages.tsx';

const readDomainPages = () => fs.readFileSync(domainPagesPath, 'utf8');

test('CFR-001: estado deletedRideNotice existe em RouteDetailsPage', () => {
  assert.match(readDomainPages(), /deletedRideNotice/, 'estado deletedRideNotice ausente');
});

test('CFR-001: rastreio da oferta aceita anterior via lastAcceptedRef', () => {
  assert.match(readDomainPages(), /lastAcceptedRef/, 'lastAcceptedRef (useRef) ausente');
});

test('CFR-001: texto literal do aviso de exclusão renderizado', () => {
  assert.match(
    readDomainPages(),
    /A carona que você integrava foi excluída pelo motorista\. Procure outra oferta no evento ou ofereça uma nova\./,
    'texto do aviso de exclusão ausente'
  );
});

test('CFR-001: card "Carona indisponível" com dismiss do aviso', () => {
  const source = readDomainPages();
  assert.match(source, /Carona indisponível/, 'título do card de aviso ausente');
  assert.match(source, /setDeletedRideNotice\(null\)/, 'dismiss do aviso ausente');
});