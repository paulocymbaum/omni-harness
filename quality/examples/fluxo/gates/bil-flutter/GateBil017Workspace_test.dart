// Gate BIL-017-PARIDADE-WORKSPACE, lado Dart. Template do autor de gates: copiado para test/features/fluxo_empresas só durante o gate.
// Contrato que este template fixa, além da spec: BusinessWorkspace workspaceFor(BusinessType primaryType, Iterable<String?> cnaes), com `tabs`, `copyFor(tab)` e os campos
// de hoje com o mesmo nome, e as funções catalogItemLabel, catalogItemNameLabel, catalogImageTitle, catalogImageSubtitle, defaultOrderItemName, defaultServiceName e
// merchantTypeFromBusinessType(String) no mesmo arquivo. O domínio não importa Flutter: ícone é chave lógica.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:fluxo/features/businesses/domain/model/business_profile_model.dart';
import 'package:fluxo/features/fluxo_empresas/domain/business_workspace.dart';

String _norm(String value) {
  const from = 'áàâãäéêèíìóôõöúùüçÁÀÂÃÉÊÍÓÔÕÚÇ';
  const to = 'aaaaaeeeiiooooouuucAAAAEEIOOOUC';
  final buffer = StringBuffer();
  for (final rune in value.runes) {
    final char = String.fromCharCode(rune);
    final index = from.indexOf(char);
    buffer.write(index >= 0 ? to[index] : char);
  }
  return buffer.toString().toLowerCase();
}

Map<String, Object?> _produce(String primary, List<String?> cnaes) {
  final w = workspaceFor(BusinessType.fromWire(primary), cnaes);
  return {
    'type': w.type.wireValue,
    'merchantType': merchantTypeFromBusinessType(primary),
    'tabs': [
      for (final tab in w.tabs)
        {
          'key': tab.name,
          'label': w.copyFor(tab).label,
          'title': w.copyFor(tab).title,
        },
    ],
    'leadTitle': w.leadTitle,
    'leadSubtitle': w.leadSubtitle,
    'leadChips': w.leadChips,
    'dashboardTitle': w.dashboardTitle,
    'dashboardSubtitle': w.dashboardSubtitle,
    'catalogTitle': w.catalogTitle,
    'catalogSubtitle': w.catalogSubtitle,
    'catalogActionLabel': w.catalogActionLabel,
    'catalogEmptyText': w.catalogEmptyText,
    'categoryHint': w.categoryHint,
    'orderTitle': w.orderTitle,
    'orderSubtitle': w.orderSubtitle,
    'orderActionLabel': w.orderActionLabel,
    'orderEmptyText': w.orderEmptyText,
    'agendaTitle': w.agendaTitle,
    'agendaSubtitle': w.agendaSubtitle,
    'serviceActionLabel': w.serviceActionLabel,
    'serviceEmptyText': w.serviceEmptyText,
    'teamSubtitle': w.teamSubtitle,
    'linksTitle': w.linksTitle,
    'linksSubtitle': w.linksSubtitle,
    'catalogItemLabel': catalogItemLabel(w),
    'catalogItemNameLabel': catalogItemNameLabel(w),
    'catalogImageTitle': catalogImageTitle(w),
    'catalogImageSubtitle': catalogImageSubtitle(w),
    'defaultOrderItemName': defaultOrderItemName(w),
    'defaultServiceName': defaultServiceName(w),
  };
}

void main() {
  final golden =
      jsonDecode(
            File(
              'quality/test/delivery/fixtures/bil-017-workspace.golden.json',
            ).readAsStringSync(),
          )
          as Map<String, dynamic>;
  for (final item in (golden['cases'] as List).cast<Map<String, dynamic>>()) {
    final primary = item['primaryType'] as String;
    final cnaes = (item['cnaes'] as List).cast<String?>();
    test('paridade: $primary $cnaes', () {
      expect(
        _norm(jsonEncode(_produce(primary, cnaes))),
        _norm(jsonEncode(item['expected'])),
      );
    });
  }
}
