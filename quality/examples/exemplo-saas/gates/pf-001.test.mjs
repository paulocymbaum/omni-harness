// Gates PF-001 — integração HTTP/PostgreSQL real para encontros cívicos API-first.
// Antes da implementação, cada gate falha se sua prova xUnit ainda não existe.
// Requer FLUXO_TEST_POSTGRES apontando para um PostgreSQL descartável: testes
// pulados não contam como evidência de comportamento.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROJECT = 'backend/tests/Exemplo SaaS.Api.Tests/Exemplo SaaS.Api.Tests.csproj';

function runIntegrationTest(method) {
  const result = spawnSync('dotnet', [
    'test',
    PROJECT,
    '--filter',
    `FullyQualifiedName~Exemplo SaaS.Api.Tests.CivicEventJourneyTests.${method}&Category=PostgresIntegration`,
    '--logger',
    'console;verbosity=detailed',
    '--nologo',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 110_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

  assert.equal(
    result.error,
    undefined,
    `dotnet test não executou (${result.error?.message ?? 'erro desconhecido'}):\n${output}`,
  );
  assert.equal(result.status, 0, `dotnet test falhou para ${method}:\n${output}`);
  assert.ok(
    output.includes(method),
    `o teste PostgreSQL requerido "${method}" não foi descoberto:\n${output}`,
  );
  assert.match(output, /Total tests:\s*1\b/, `esperava exatamente um teste executado:\n${output}`);
  assert.match(output, /Passed:\s*1\b/, `o teste requerido não passou:\n${output}`);
  assert.doesNotMatch(output, /Skipped:\s*[1-9]\d*\b/i, `teste de integração foi pulado:\n${output}`);
}

test('PF-001 geo-context: pessoa/business persistem e retornam geo e CivicContext tipado integral', () => {
  runIntegrationTest('Personal_and_business_create_round_trips_geo_and_full_context');
});

test('PF-001 private-read: evento publicado privado respeita autorização e não aparece na descoberta pública', () => {
  runIntegrationTest('Published_private_events_are_hidden_from_public_discovery_and_enforce_read_authorization');
});

test('PF-001 idempotent-outbox: replay persiste um evento e uma solicitação de projeção na outbox', () => {
  runIntegrationTest('Idempotent_create_commits_one_event_and_one_projection_outbox_message');
});
