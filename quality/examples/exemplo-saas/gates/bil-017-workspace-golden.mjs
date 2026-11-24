#!/usr/bin/env node
// Gera quality/test/delivery/fixtures/bil-017-workspace.golden.json a partir do código real do app no commit 6839c7d2, sem digitar nenhum rótulo.
// Corta do fonte de fluxo_empresas_pages.dart a regra por tipo (funções privadas) e do cubit o tipo de merchant, roda num teste Flutter temporário e grava o JSON.
// Roda uma vez, na Fase B. O hash do resultado fica em bil-017.test.mjs.
// Uso: node quality/test/delivery/bil-017-workspace-golden.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const COMMIT = '6839c7d2';
const PAGES = 'lib/features/fluxo_empresas/presentation/pages/fluxo_empresas_pages.dart';
const CUBIT = 'lib/features/fluxo_empresas/presentation/bloc/fluxo_empresas_cubit.dart';
const OUTPUT = path.join(ROOT, 'quality/test/delivery/fixtures/bil-017-workspace.golden.json');
const TEST = path.join(ROOT, 'test/features/fluxo_empresas/gate_bil017_golden_gen_test.dart');
const DUMP = path.join(path.dirname(OUTPUT), '.bil-017-golden-dump.json');

const show = (file) => execFileSync('git', ['show', `${COMMIT}:${file}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const between = (text, from, to) => {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`trecho não encontrado: ${from} .. ${to}`);
  return text.slice(start, end);
};

const pages = show(PAGES);
const cubit = show(CUBIT);
const rule = between(pages, 'enum _BusinessTab {', "String _titleForBusinessTab(");
const labels = between(pages, 'String _defaultOrderItemName(', 'IconData _catalogImageIcon(');
const merchantType = between(cubit, 'String _merchantTypeFromBusinessType(', 'String _friendly(');

const CASES = [
  ['FOOD_PLACE', []], ['SERVICE_PROVIDER', []], ['SELLER', []], ['VENUE', []], ['EVENT_ORGANIZER', []], ['DIGITAL_CREATOR', []], ['BRAND', []],
  ['VALOR_DESCONHECIDO', []], ['', []],
  ['FOOD_PLACE', ['47.81-4/00']], ['FOOD_PLACE', ['9001-9/01']], ['FOOD_PLACE', ['96.02-5/01']], ['FOOD_PLACE', ['73.19-0/02']],
  ['SERVICE_PROVIDER', ['4781-4/00']], ['SERVICE_PROVIDER', ['9329-8/99']], ['SELLER', ['5611-2/01']], ['SELLER', ['9602-5/01']], ['SELLER', ['7319-0/02']],
  ['VENUE', ['5611-2/01']], ['EVENT_ORGANIZER', ['4781-4/00']], ['DIGITAL_CREATOR', ['4781-4/00']], ['DIGITAL_CREATOR', ['7319-0/02']], ['DIGITAL_CREATOR', ['5611-2/01']],
  ['BRAND', ['4781-4/00']], ['BRAND', ['9609-2/08']], ['VALOR_DESCONHECIDO', ['5611-2/01']],
  ['FOOD_PLACE', ['47.81-4/00', '9001-9/01', '9602-5/01']], ['FOOD_PLACE', ['0111-3/01']], ['FOOD_PLACE', ['5611-2/01']], ['SELLER', [null, '']],
];

const dart = `// Gerado por quality/test/delivery/bil-017-workspace-golden.mjs. Removido ao fim.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fluxo/features/business_accounts/domain/model/business_account_model.dart';
import 'package:fluxo/features/businesses/domain/model/business_profile_model.dart';

${rule}
${labels}
${merchantType}

const _cases = ${JSON.stringify(CASES).replace(/\$/g, '\\$')};

Map<String, Object?> _dump(String primary, List<String?> cnaes) {
  final account = BusinessAccount(
    businessId: 'gate', legalName: 'gate', tradeName: 'gate', fluxoBusinessType: primary, verificationLevel: 'none',
    statusCode: 'active', trustScore: 0, ownerVerifiedCount: 0, ownerUids: const [],
    cnaeMain: cnaes.isEmpty ? null : cnaes.first,
    cnaeSecondary: cnaes.skip(1).whereType<String>().toList(),
  );
  final w = _workspaceFor(account);
  return {
    'primaryType': primary,
    'cnaes': cnaes,
    'expected': {
      'type': w.type.wireValue,
      'merchantType': _merchantTypeFromBusinessType(primary),
      'tabs': [for (final tab in w.tabs) {'key': tab.name, 'label': w.copyFor(tab).label, 'title': w.copyFor(tab).title}],
      'leadTitle': w.leadTitle, 'leadSubtitle': w.leadSubtitle, 'leadChips': w.leadChips,
      'dashboardTitle': w.dashboardTitle, 'dashboardSubtitle': w.dashboardSubtitle,
      'catalogTitle': w.catalogTitle, 'catalogSubtitle': w.catalogSubtitle, 'catalogActionLabel': w.catalogActionLabel,
      'catalogEmptyText': w.catalogEmptyText, 'categoryHint': w.categoryHint,
      'orderTitle': w.orderTitle, 'orderSubtitle': w.orderSubtitle, 'orderActionLabel': w.orderActionLabel, 'orderEmptyText': w.orderEmptyText,
      'agendaTitle': w.agendaTitle, 'agendaSubtitle': w.agendaSubtitle,
      'serviceActionLabel': w.serviceActionLabel, 'serviceEmptyText': w.serviceEmptyText,
      'teamSubtitle': w.teamSubtitle, 'linksTitle': w.linksTitle, 'linksSubtitle': w.linksSubtitle,
      'catalogItemLabel': _catalogItemLabel(w), 'catalogItemNameLabel': _catalogItemNameLabel(w),
      'catalogImageTitle': _catalogImageTitle(w), 'catalogImageSubtitle': _catalogImageSubtitle(w),
      'defaultOrderItemName': _defaultOrderItemName(w), 'defaultServiceName': _defaultServiceName(w),
    },
  };
}

void main() {
  test('gera o golden', () {
    final cases = [for (final c in _cases) _dump(c[0] as String, (c[1] as List).cast<String?>())];
    File(${JSON.stringify(DUMP)}).writeAsStringSync(jsonEncode(cases));
  });
}
`;

try {
  fs.writeFileSync(TEST, dart);
  const run = spawnSync('flutter', ['test', '--no-pub', '--reporter=compact', path.relative(ROOT, TEST)], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`flutter test falhou:\n${run.stdout}\n${run.stderr}`);
  const cases = JSON.parse(fs.readFileSync(DUMP, 'utf8'));
  const golden = { commit: execFileSync('git', ['rev-parse', COMMIT], { cwd: ROOT, encoding: 'utf8' }).trim(), command: 'node quality/test/delivery/bil-017-workspace-golden.mjs', source: [PAGES, CUBIT], cases };
  fs.writeFileSync(OUTPUT, `${JSON.stringify(golden, null, 1)}\n`);
  console.log(`${cases.length} casos em ${path.relative(ROOT, OUTPUT)}`);
} finally {
  fs.rmSync(TEST, { force: true });
  fs.rmSync(DUMP, { force: true });
}
