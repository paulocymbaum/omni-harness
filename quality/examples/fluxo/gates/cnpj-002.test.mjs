// Gate CNPJ-G002-STATIC — cnpj_utils.dart e teclado da tela de verificação aceitam letras.
// ANTES da implementação este teste DEVE falhar (normalizeCnpj usa \D e remove letras).
// Complementa o gate de comportamento CNPJ-G002-FLUTTER (flutter test test/shared/utils/cnpj_utils_test.dart).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const utils = fs.readFileSync('lib/shared/utils/cnpj_utils.dart', 'utf8');
const screen = fs.readFileSync(
  'lib/features/business_accounts/presentation/business_cnpj_verification_screen.dart', 'utf8');

test('normalizeCnpj mantém alfanuméricos e converte para maiúsculas', () => {
  // Extrai a declaração inteira até o ';' (tolerante a quebra de linha do dart format).
  const start = utils.indexOf('String normalizeCnpj');
  assert.ok(start >= 0, 'normalizeCnpj não encontrado');
  const end = utils.indexOf(';', start);
  assert.ok(end > start, 'fim da declaração de normalizeCnpj não encontrado');
  const decl = utils.slice(start, end + 1);
  assert.match(decl, /\[\^0-9A-Za-z\]/);
  assert.match(decl, /toUpperCase\(\)/);
  assert.doesNotMatch(utils, /RegExp\(r'\\D'\)/);
});

test('mensagem de erro é neutra (14 caracteres)', () => {
  assert.match(utils, /cnpjLengthErrorMessage\s*=\s*'O CNPJ deve conter 14 caracteres\.'/);
});

test('tela de verificação usa teclado de texto com caixa alta, não numérico', () => {
  const field = screen.slice(screen.indexOf('CnpjInputFormatter') - 600, screen.indexOf('CnpjInputFormatter') + 100);
  assert.match(field, /TextInputType\.text/);
  assert.match(field, /TextCapitalization\.characters/);
  assert.doesNotMatch(field, /TextInputType\.number/);
});
