// BIL-017-INDICES. Lê do fonte as consultas do app e do site e exige índice composto em firestore.indexes.json.
import { exists, read, walk } from '../bil-gate-helper.mjs';
import { collector } from '../bil-017-gate-helper.mjs';

const APP = 'lib/features/fluxo_empresas/data/fluxo_empresas_repository_impl.dart';
const REPO = 'ofluxo_site/src/platform/infrastructure/repositories.ts';
const BUSINESS_PAGES = 'ofluxo_site/src/platform/presentation/pages/business';
const SITE_COLLECTIONS = 'orders|services|appointments|affiliate_links|commission_ledger';
// Contrato de F1.5: o site precisa fazer estas consultas, e o parser precisa enxergá-las.
const SITE_REQUIRED = [
  'orders businessId== createdAt:desc', 'services businessId== name:asc', 'appointments businessId== startsAt:desc',
  'affiliate_links producerBusinessId== status== updatedAt:desc', 'commission_ledger targetId== targetType== updatedAt:desc',
];

const key = (q) => [q.collection, ...[...q.equal].sort().map((f) => `${f}==`), ...q.order.map((o) => `${o.field}:${o.dir}`)].join(' ');

function dartQueries(source) {
  const chains = source.match(/\.collection\('[^']+'\)[\s\S]*?\.(?:snapshots|get)\(\)/g) ?? [];
  return chains.map((chain) => {
    const collection = /\.collection\('([^']+)'\)/.exec(chain)[1];
    const equal = [...chain.matchAll(/\.where\(\s*'([^']+)'\s*,\s*isEqualTo:/g)].map((m) => m[1]);
    const order = [...chain.matchAll(/\.orderBy\(\s*'([^']+)'(?:\s*,\s*descending:\s*(true|false))?/g)].map((m) => ({ field: m[1], dir: m[2] === 'true' ? 'desc' : 'asc' }));
    return { origin: 'app', collection, equal, order };
  });
}

function siteQueries(source) {
  const blocks = source.match(new RegExp(`query\\(\\s*collection\\(\\s*\\w+\\s*,\\s*'(?:${SITE_COLLECTIONS})'[\\s\\S]*?\\n?\\s*\\)\\s*[,;)]`, 'g')) ?? [];
  return blocks.map((block) => {
    const collection = /collection\(\s*\w+\s*,\s*'([^']+)'/.exec(block)[1];
    const equal = [...block.matchAll(/where\(\s*'([^']+)'\s*,\s*'=='/g)].map((m) => m[1]);
    const order = [...block.matchAll(/orderBy\(\s*'([^']+)'(?:\s*,\s*'(asc|desc)')?/g)].map((m) => ({ field: m[1], dir: m[2] ?? 'asc' }));
    return { origin: 'site', collection, equal, order };
  });
}

const hasIndex = (indexes, q) => indexes.some((index) => {
  if ((index.collectionGroup ?? index.collectionId) !== q.collection) return false;
  const fields = index.fields.filter((f) => f.fieldPath !== '__name__');
  if (fields.length !== q.equal.length + q.order.length) return false;
  const head = fields.slice(0, q.equal.length).map((f) => f.fieldPath).sort();
  if (head.join() !== [...q.equal].sort().join()) return false;
  return q.order.every((o, i) => {
    const f = fields[q.equal.length + i];
    return f.fieldPath === o.field && f.order === (o.dir === 'desc' ? 'DESCENDING' : 'ASCENDING');
  });
});

export function runIndices() {
  const { check, done } = collector();
  const indexes = JSON.parse(read('firestore.indexes.json')).indexes;
  const app = dartQueries(read(APP));
  check('parser enxerga as cinco consultas do app', app.length >= 5, `encontrou ${app.length}`);
  const repo = read(REPO);
  const section = repo.slice(repo.indexOf('export const fluxoEmpresasRepository'));
  const pages = exists(BUSINESS_PAGES) ? walk(BUSINESS_PAGES, (f) => /\.tsx?$/.test(f)).map(read).join('\n') : '';
  const site = siteQueries(`${section}\n${pages}`);
  const seen = new Set(site.map(key));
  for (const required of SITE_REQUIRED) check(`site faz a consulta ${required}`, seen.has(required));
  for (const q of [...app, ...site]) {
    if (q.equal.length + q.order.length < 2) continue;
    check(`índice de ${q.origin} ${key(q)}`, hasIndex(indexes, q));
  }
  const services = { collection: 'services', equal: ['businessId'], order: [{ field: 'name', dir: 'asc' }] };
  check('índice novo services businessId+name (F1.6)', hasIndex(indexes, services));
  done();
}
