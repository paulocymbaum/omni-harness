// Gate CNPJ-G001-STATIC — Business.RequestVerification aceita CNPJ alfanumérico (fonte .NET).
// ANTES da implementação este teste DEVE falhar (Business.cs ainda descarta letras).
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-10-02-cnpj-alfanumerico-correcoes CNPJ-001 --baseline
// O gate dinâmico real (dotnet test) é o gate manual CNPJ-G001-DOTNET: dotnet não está no PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = 'backend/src/Fluxo.Api/Modules/Businesses/Business.cs';
const src = fs.readFileSync(SRC, 'utf8');
const method = src.slice(src.indexOf('RequestVerification('));

test('normalização do CNPJ preserva letras A-Z (regex [^0-9A-Z])', () => {
  assert.match(src, /new\(\s*"\[\^0-9A-Z\]\+"/, 'regex de limpeza deve manter 0-9 e A-Z');
  assert.doesNotMatch(src, /new\(\s*"\[\^0-9\]\+"/, 'regex que descarta letras não pode permanecer');
});

// Em C# o argumento de Replace(...) é avaliado ANTES da chamada. Logo, "upper antes do regex"
// significa: ToUpperInvariant() está DENTRO dos argumentos de Replace(. Comparar indexOf textual é frágil.
function replaceArgs(line) {
  const open = line.indexOf('Replace(');
  if (open < 0) return null;
  let depth = 0;
  for (let i = open + 'Replace'.length; i < line.length; i++) {
    if (line[i] === '(') depth++;
    else if (line[i] === ')' && --depth === 0) return line.slice(open + 'Replace('.length, i);
  }
  return null;
}

test('minúsculas viram maiúsculas ANTES do regex (ToUpperInvariant dentro dos args do Replace)', () => {
  const line = method.split('\n').find((l) => /Replace\(/.test(l) && /cnpj/i.test(l));
  assert.ok(line, 'linha de normalização do cnpj não encontrada');
  const args = replaceArgs(line);
  assert.ok(args !== null, 'parênteses da chamada Replace( desbalanceados');
  assert.match(args, /ToUpperInvariant\(\)/, 'ToUpperInvariant() deve ser aplicado ao argumento de Replace(, não depois');
});

test('código invalid_cnpj preservado e mensagem não fala mais só em dígitos', () => {
  assert.match(method, /"invalid_cnpj"/);
  assert.doesNotMatch(method, /14 digits/);
  assert.match(method, /14 alphanumeric/);
});
