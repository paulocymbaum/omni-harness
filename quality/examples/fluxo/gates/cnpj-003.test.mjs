// Gate CNPJ-G003-STATIC — tela de claim ownership usa CnpjInputFormatter no campo CNPJ.
// ANTES da implementação este teste DEVE falhar (TextField cru, sem formatter).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(
  'lib/features/business_accounts/presentation/business_claim_ownership_screen.dart', 'utf8');
const i = src.indexOf('_cnpjController,');
const field = src.slice(Math.max(0, i - 200), i + 700);

test('importa cnpj_utils', () => {
  assert.match(src, /import '\.\.\/\.\.\/\.\.\/shared\/utils\/cnpj_utils\.dart';/);
});

test('campo CNPJ tem CnpjInputFormatter, teclado de texto e caixa alta', () => {
  assert.match(field, /inputFormatters:\s*(const\s*)?\[\s*(const\s*)?CnpjInputFormatter\(\)\s*\]/);
  assert.match(field, /TextInputType\.text/);
  assert.match(field, /TextCapitalization\.characters/);
  assert.doesNotMatch(field, /TextInputType\.number/);
});

test('claimOwnership recebe CNPJ normalizado e businessId não ganha formatter', () => {
  assert.match(src, /cnpj:\s*normalizeCnpj\(\s*_cnpjController\.text\s*\)/);
  const j = src.indexOf('_businessIdController,');
  assert.doesNotMatch(src.slice(j, j + 300), /CnpjInputFormatter/);
});
