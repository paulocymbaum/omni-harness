// Gates P0 do Fluxo Ônibus (piloto BH — GTFS estático).
// Três grupos selecionáveis via --test-name-pattern:
//   contrato — MOB-001 (documento de contrato em docs/mobilidade/)
//   backend  — MOB-002 (módulo Mobility na API .NET)
//   flutter  — MOB-003 (feature mobility no app + wiring do mapa)
// Rodar: node --test [--test-name-pattern=<grupo>] quality/test/mobility-p0.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

/** Lê arquivo do repo com falha clara quando ausente (gate = estrutura mínima). */
function mustRead(relPath) {
  const full = path.join(ROOT, relPath);
  if (!fs.existsSync(full)) {
    assert.fail(`arquivo ausente: ${relPath}`);
  }
  return fs.readFileSync(full, 'utf8');
}

// ── MOB-001 — contrato P0 ─────────────────────────────────────────────────────

test('contrato: documento P0 existe com endpoints, fonte e degradação', () => {
  const doc = mustRead('docs/mobilidade/contrato-fluxo-onibus-p0.md');

  for (const expected of [
    '/api/v1/mobility/transit/cities',
    '/api/v1/mobility/transit/{city}/lines',
    '/api/v1/mobility/transit/{city}/lines/{lineId}',
    '/api/v1/mobility/transit/{city}/stops',
    'minLat',
    'maxLng',
  ]) {
    assert.ok(doc.includes(expected), `contrato deve citar "${expected}"`);
  }

  // fonte P0 e atribuição obrigatória (CC-BY BHTrans)
  assert.match(doc, /BHTrans/i, 'fonte BHTrans deve estar no contrato');
  assert.match(doc, /CC-BY/i, 'atribuição CC-BY deve estar no contrato');
  assert.match(doc, /GTFS/i, 'formato da fonte deve ser GTFS');

  // degradação explícita: feed indisponível não é tela vazia silenciosa
  assert.match(doc, /503/, 'contrato deve definir 503 para feed indisponível');
  assert.match(doc, /retry-?after/i, 'contrato deve definir retry-after no 503');

  // privacidade/custo: sem dado pessoal e sem listener de Firestore
  assert.match(doc, /sem dado pessoal|não é dado pessoal|LGPD/i);
  assert.ok(!/snapshot/i.test(doc), 'P0 não usa listener/snapshot para trânsito');
});

// ── MOB-002 — backend .NET ────────────────────────────────────────────────────

test('backend: módulo Mobility criado e registrado no Program.cs', () => {
  const module = mustRead('backend/src/Fluxo.Api/Modules/Mobility/MobilityModule.cs');
  assert.ok(module.includes('AddMobilityModule'), 'DI AddMobilityModule ausente');
  assert.ok(module.includes('MapMobilityEndpoints'), 'MapMobilityEndpoints ausente');

  for (const route of [
    'transit/cities',
    'transit/{city}/lines',
    'transit/{city}/lines/{lineId}',
    'transit/{city}/stops',
  ]) {
    assert.ok(module.includes(route), `rota ausente no módulo: ${route}`);
  }
  assert.ok(module.includes('AllowAnonymous'), 'endpoints públicos de P0 devem ser AllowAnonymous (rate limit do grupo protege)');
  assert.match(module, /\bAttribution\b/, 'responses devem carregar o campo de atribuição da fonte (serializado como attribution)');

  const program = mustRead('backend/src/Fluxo.Api/Program.cs');
  assert.ok(program.includes('AddMobilityModule(builder.Configuration)'), 'Program.cs não registra AddMobilityModule');
  assert.ok(program.includes('MapMobilityEndpoints()'), 'Program.cs não mapeia MapMobilityEndpoints');
});

test('backend: parser GTFS com cache TTL e configuração BhTrans', () => {
  const feed = mustRead('backend/src/Fluxo.Api/Modules/Mobility/GtfsStaticFeed.cs');
  for (const expected of ['routes.txt', 'stops.txt', 'trips.txt', 'shapes.txt', 'agency.txt']) {
    assert.ok(feed.includes(expected), `parser GTFS deve ler ${expected}`);
  }
  assert.ok(feed.includes('IMemoryCache'), 'cache em memória é obrigatório no P0');
  assert.ok(/ttl/i.test(feed), 'cache deve ter TTL configurável');

  const settings = mustRead('backend/src/Fluxo.Api/appsettings.json');
  assert.ok(settings.includes('"Mobility"'), 'appsettings sem seção Mobility');
  assert.ok(settings.includes('"BhTrans"'), 'appsettings sem fonte BhTrans');
  assert.ok(settings.includes('Attribution'), 'appsettings sem atribuição da fonte');
  assert.ok(settings.includes('/api/v1/mobility/transit'), 'appsettings sem path público de trânsito');

  const options = mustRead('backend/src/Fluxo.Api/Infrastructure/Security/FirebaseSecurityOptions.cs');
  assert.ok(options.includes('AnonymousPaths'), 'boundary sem allowlist de leitura pública');

  const middleware = mustRead('backend/src/Fluxo.Api/Infrastructure/Security/FirebaseSecurityMiddleware.cs');
  assert.ok(middleware.includes('IsAnonymousAllowedPath'), 'middleware não honra AnonymousPaths');
});

test('backend: testes do parser GTFS existem no projeto de testes', () => {
  const tests = mustRead('backend/tests/Fluxo.Api.Tests/Mobility/GtfsStaticFeedTests.cs');
  assert.ok(tests.includes('Fact') || tests.includes('Theory'), 'testes xUnit ausentes');
  assert.ok(tests.includes('GtfsStaticFeed'), 'testes devem exercitar GtfsStaticFeed');
});

// ── MOB-003 — flutter ─────────────────────────────────────────────────────────

test('flutter: feature mobility com domínio Dart puro (selftest executável)', () => {
  const models = mustRead('lib/features/mobility/domain/transit_models.dart');
  assert.ok(models.includes('class TransitLine'), 'TransitLine ausente');
  assert.ok(models.includes('class TransitStop'), 'TransitStop ausente');
  assert.ok(models.includes('class TransitCity'), 'TransitCity ausente');
  assert.ok(models.includes('fromJson'), 'models precisam de fromJson');
  assert.ok(!models.includes('package:flutter'), 'domain deve ser Dart puro (sem flutter)');

  const bbox = mustRead('lib/features/mobility/domain/transit_bbox.dart');
  assert.ok(bbox.includes('minLat'), 'bbox filter ausente');
  assert.ok(!bbox.includes('package:flutter'), 'bbox deve ser Dart puro');

  assert.ok(fs.existsSync(path.join(ROOT, 'tool/mobility_selftest.dart')), 'tool/mobility_selftest.dart ausente');
});

test('flutter: gateway, cubit, widgets e wiring do mapa presentes', () => {
  const gateway = mustRead('lib/features/mobility/data/transit_gateway.dart');
  assert.ok(gateway.includes('FluxoApiClient'), 'gateway deve usar FluxoApiClient');
  // Caminho relativo (sem barra inicial): o FluxoApiClient resolve contra
  // https://api.ofluxo.app/api/v1/ — barra inicial descartaria o /api/v1.
  assert.ok(gateway.includes("'mobility/transit'"), 'gateway deve usar o path relativo do contrato P0');
  assert.ok(!gateway.includes("getJson('/"), 'paths não podem começar com / (quebra o base /api/v1/)');

  mustRead('lib/features/mobility/presentation/bloc/transit_cubit.dart');
  const layers = mustRead('lib/features/mobility/presentation/widgets/transit_map_layers.dart');
  assert.ok(layers.includes('Polyline') || layers.includes('polyline'), 'camada de shape (polyline) ausente');

  const sheet = mustRead('lib/features/mobility/presentation/widgets/transit_lines_sheet.dart');
  assert.ok(sheet.includes('attribution'), 'ficha de linhas deve exibir atribuição da fonte');

  const registration = mustRead('lib/features/mobility/mobility_registration.dart');
  assert.ok(registration.includes('registerMobilityModule'), 'registro do módulo ausente');

  const locator = mustRead('lib/service_locator.dart');
  assert.ok(locator.includes('registerMobilityModule'), 'service_locator não registra o módulo mobility');

  const mapPage = mustRead('lib/features/map/presentation/map_page.dart');
  assert.ok(
    mapPage.includes('transit') || mapPage.includes('Transit'),
    'map_page.dart não monta a camada de transporte (wiring ausente)',
  );
});