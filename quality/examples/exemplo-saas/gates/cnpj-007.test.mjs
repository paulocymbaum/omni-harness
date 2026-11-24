// Gate CNPJ-G007-COUNT — DomainTests.cs cobre CNPJ alfanumérico com vetores reais e asserts de verdade.
// ANTES da implementação este teste DEVE falhar (nenhum vetor alfanumérico em DomainTests.cs).
// A execução real (dotnet test) é o gate manual CNPJ-G007-DOTNET.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync('backend/tests/Exemplo SaaS.Api.Tests/DomainTests.cs', 'utf8');

test('vetores alfanuméricos oficiais presentes', () => {
  assert.match(src, /12ABC34501DE35/);
  assert.match(src, /FIOQ0000000136/);
  assert.match(src, /12\.abc\.345\/01de-35/);
});

test('máscara esperada do alfanumérico e comprimentos inválidos cobertos', () => {
  assert.match(src, /\*\*\.\*\*\*\.345\/\*\*\*\*-35/);
  assert.match(src, /12ABC34501DE3"/);
  assert.match(src, /12ABC34501DE355"/);
});

test('regressão numérica mantida e sem asserts tautológicos', () => {
  assert.match(src, /11222333000181/);
  assert.doesNotMatch(src, /Assert\.True\(\s*true\s*\)/);
});
