// Gates PF-003 — paridade comportamental dos widgets, mapa e publicação Flutter.
// Cada caso exige a execução de um teste Flutter widget/unitário nomeado e
// distinto; um teste não descoberto ou pulado não constitui evidência.
import { test } from 'node:test';
import { runFlutterCase } from './pf-flutter-gate-helper.mjs';

const WIDGETS = 'test/features/civic/civic_widgets_test.dart';
const EVENTS = 'test/features/civic/civic_events_test.dart';

const cases = [
  {
    marker: 'PF-003-SCOPE-NAVIGATION',
    file: WIDGETS,
    name: 'PF-003 SCOPE-NAVIGATION — BR para UF, Exterior, voltar e deep link preservam recorte e seleções',
  },
  {
    marker: 'PF-003-NATIVE-MAP-CONTROLLER',
    file: WIDGETS,
    name: 'PF-003 NATIVE-MAP-CONTROLLER — seleção usa view-model tipado, local vence município e controller libera recursos',
  },
  {
    marker: 'PF-003-NO-WEBVIEW',
    file: WIDGETS,
    name: 'PF-003 NO-WEBVIEW — rota Pulso renderiza mapa Flutter nativo e não contém WebView',
  },
  {
    marker: 'PF-003-CANDIDATE-CHART',
    file: WIDGETS,
    name: 'PF-003 CANDIDATE-CHART — apresenta candidaturas dinâmicas, zero distinto de ausente e filtros preservados',
  },
  {
    marker: 'PF-003-EXPLORER-SHEET',
    file: WIDGETS,
    name: 'PF-003 EXPLORER-SHEET — snap mobile minimiza e reabre sem perder filtros e oferece alternativa de lista',
  },
  {
    marker: 'PF-003-CREATE-CONFIRMATIONS',
    file: EVENTS,
    name: 'PF-003 CREATE-CONFIRMATIONS — bloqueia publicação sem local confirmado, autorização e organizer autorizado',
  },
  {
    marker: 'PF-003-CREATE-IDEMPOTENCY',
    file: EVENTS,
    name: 'PF-003 CREATE-IDEMPOTENCY — retry indeterminado conserva corpo e chave e intenção alterada confirmada gera nova chave',
  },
  {
    marker: 'PF-003-PRIVATE-EVENT',
    file: EVENTS,
    name: 'PF-003 PRIVATE-EVENT — encontro privado publicado fica fora do mapa público e detalhe autorizado usa API',
  },
  {
    marker: 'PF-003-REST-NO-FIRESTORE-FALLBACK',
    file: EVENTS,
    name: 'PF-003 REST-NO-FIRESTORE-FALLBACK — erro API cívico é propagado sem leitura ou escrita Firestore',
  },
];

for (const { marker, file, name } of cases) {
  test(`${marker}: ${name}`, () => runFlutterCase(file, name));
}
