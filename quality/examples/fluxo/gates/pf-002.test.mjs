// Gates PF-002 — paridade comportamental do domínio e dos repositórios Flutter.
// Cada caso exige a execução de um teste Flutter unitário nomeado, não a mera
// presença do arquivo de teste nem um `flutter test` sem descoberta comprovada.
import { test } from 'node:test';
import { runFlutterCase } from './pf-flutter-gate-helper.mjs';

const DOMAIN = 'test/features/civic/civic_domain_test.dart';
const LOADERS = 'test/features/civic/civic_loaders_test.dart';

const cases = [
  {
    marker: 'PF-002-CANDIDATES-13',
    file: DOMAIN,
    name: 'PF-002 CANDIDATES-13 — carrega as 13 candidaturas do dataset, mantém identidades nulas e rejeita duplicatas',
  },
  {
    marker: 'PF-002-EXTERIOR-KEYS',
    file: DOMAIN,
    name: 'PF-002 EXTERIOR-KEYS — normaliza chaves TSE e zeros sem confundir exterior com IBGE nem nulo com zero',
  },
  {
    marker: 'PF-002-PROFILE-MARGINALS',
    file: DOMAIN,
    name: 'PF-002 PROFILE-MARGINALS — preserva cubo e marginais distintos, coverage parcial nula e rejeita cruzamento fictício',
  },
  {
    marker: 'PF-002-GEO-POLYGONS',
    file: DOMAIN,
    name: 'PF-002 GEO-POLYGONS — respeita buracos, bordas e multipolígonos e escolhe local pela distância geodésica',
  },
  {
    marker: 'PF-002-FILTER-AND',
    file: DOMAIN,
    name: 'PF-002 FILTER-AND — combina filtros por AND e candidatura precede lean sem remover os demais filtros',
  },
  {
    marker: 'PF-002-LOADERS-STALE-RETRY',
    file: LOADERS,
    name: 'PF-002 LOADERS-STALE-RETRY — usa URLs lowercase, descarta resposta obsoleta e permite retry independente após falha',
  },
  {
    marker: 'PF-002-NEARBY-CALLABLE',
    file: LOADERS,
    name: 'PF-002 NEARBY-CALLABLE — envia somente centro e categoria e representa limites, atribuição e falha do callable',
  },
  {
    marker: 'PF-002-ENCOUNTERS-REST',
    file: LOADERS,
    name: 'PF-002 ENCOUNTERS-REST — pagina pela API, expõe freshness e nunca lê encontros pelo Firestore',
  },
];

for (const { marker, file, name } of cases) {
  test(`${marker}: ${name}`, () => runFlutterCase(file, name));
}
