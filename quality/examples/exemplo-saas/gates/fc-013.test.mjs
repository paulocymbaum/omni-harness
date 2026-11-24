// Gates FC-013 — carrossel: fila por slide (banco/worker já prontos desde o FC-004) e a fatia de API em C#.
// O gate FC-013 api era o baseline honesto do bloqueio (dotnet ausente) e ficou verde quando a fatia C#
// (roteiro por slide, render por slide, status agregado) foi implementada em 2026-11-15 (SDK user-local).
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-11-14-fluxo-creator FC-013 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exists, read } from './fc-gate-helper.mjs';

const ENDPOINTS = 'backend/src/Exemplo SaaS.Api/Modules/Creator/CreatorProjectEndpoints.cs';
const SERVICE = 'backend/src/Exemplo SaaS.Api/Modules/Creator/Application/CreatorProjectService.cs';
const SQL = 'backend/deploy/sql/creator-jobs.sql';
const CLAIMED = 'services/creator-worker/src/handlers/registry.ts';
const SPEC = 'docs/entregas/2026-11-14-fluxo-creator/specs/FC-013.md';

test('FC-013 api: criação de projeto carousel, render por slide e status agregado em C#', () => {
  assert.ok(exists(ENDPOINTS) && exists(SERVICE), 'endpoints/serviço do projeto ausentes');
  const endpoints = read(ENDPOINTS);
  const service = read(SERVICE);
  const junto = endpoints + service;
  assert.match(junto, /carousel/i, 'criação sem kind carousel');
  assert.match(junto, /slide_index|SlideIndex|slides/i, 'render/status sem slide');
  assert.match(service, /slides/i, 'serviço sem roteiro por slide');
});

test('FC-013 worker: banco e worker já nascem prontos para a fila por slide (FC-004) — nada a mudar na fatia 1', () => {
  const sql = read(SQL);
  assert.match(sql, /slide_index/, 'SQL sem slide_index');
  assert.match(sql, /'strategy'/, 'SQL sem o kind strategy');
  const claimed = read(CLAIMED);
  assert.match(claimed, /slideIndex/, 'ClaimedJob sem slideIndex');
});

test('FC-013 docs: spec done com as fatias e os desvios da fatia C# registrados', () => {
  const spec = read(SPEC);
  assert.match(spec, /Status: done/, 'spec sem Status: done');
  assert.match(spec, /Fatia 1[\s\S]*dotnet/i, 'spec sem registrar a fatia 1 e o dotnet');
  assert.match(spec, /Desvios da spec original/, 'spec sem registrar os desvios da implementação');
  assert.ok(!/\/pdf|\/caption/i.test(spec.replace(/PDF e legenda|PDF\/legenda|por jobId/g, '')), 'spec inventou rota de PDF/legenda');
});
