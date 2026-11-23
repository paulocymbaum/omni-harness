import './bootstrap-example-profile.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRisk, runsPerDay } from '../lib/risk.mjs';
import { entry } from './helpers.mjs';

const risk = (...entries) => classifyRisk(entries);

test('quebra: um caso por nível da matriz', () => {
  assert.equal(risk(entry('backend/src/Fluxo.Api/Infrastructure/Idempotency/IdempotencyFilter.cs', 'a\n', 'b\n')).breakage.level, 'critico');
  assert.equal(risk(entry('backend/src/Fluxo.Api/Infrastructure/Persistence/Migrations/2026_X.cs', null, 'x\n')).breakage.level, 'critico');
  assert.equal(risk(entry('firestore.rules', 'a\n', 'b\n')).breakage.level, 'critico');
  assert.equal(risk(entry('functions/src/payments/services/payment_service.ts', 'a\n', 'b\n')).breakage.level, 'critico');
  assert.equal(risk(entry('backend/src/Fluxo.Api/Modules/Events/EventsModule.cs', 'a\n', 'b\n')).breakage.level, 'alto');
  assert.equal(risk(entry('lib/core/network/fluxo_api_client.dart', 'a\n', 'b\n')).breakage.level, 'alto');
  assert.equal(risk(entry('OCR_webscraper_crawler/packages/scraper/src/fetch.ts', 'a\n', 'b\n')).breakage.level, 'alto');
  assert.equal(risk(entry('functions/src/features/posts.ts', 'a\n', 'b\n')).breakage.level, 'medio');
  assert.equal(risk(entry('lib/features/feed/data/feed_repository.dart', 'a\n', 'b\n')).breakage.level, 'medio');
  assert.equal(risk(entry('lib/features/feed/presentation/feed_page.dart', 'a\n', 'b\n')).level, 'baixo');
});

test('falso positivo: docs, testes e os próprios gates não elevam o risco', () => {
  assert.equal(risk(entry('backend/README.md', 'a\n', 'min-instances: 5 firebase deploy\n')).level, 'baixo');
  assert.equal(risk(entry('docs/migration/X.md', null, 'gcloud run deploy --min-instances=3\n')).level, 'baixo');
  assert.equal(risk(entry('functions/test/payments/payment.test.js', 'a\n', "generateContent('x')\n")).level, 'baixo');
  assert.equal(risk(entry('quality/config/risk-matrix.json', 'a\n', '"--min-instances[= ]"\n')).level, 'baixo');
  // Arquivo de camada backend alterado só em Markdown não conta como camada tocada.
  const r = risk(entry('backend/README.md', 'a\n', 'b\n'), entry('functions/README.md', 'a\n', 'b\n'), entry('README.md', 'a\n', 'b\n'));
  assert.deepEqual(r.layers, []);
});

test('export removido de functions/src/index.ts é crítico', () => {
  const r = risk(entry('functions/src/index.ts', "export * from './a';\nexport const b = 1;\n", 'export const b = 1;\n'));
  assert.equal(r.breakage.level, 'critico');
});

test('custo: instâncias mínimas só sobem o risco quando aumentam', () => {
  const up = risk(entry('backend/deploy/jobs/deploy.sh', 'gcloud run deploy api --min-instances=1\n', 'gcloud run deploy api --min-instances=3\n'));
  assert.equal(up.cost.level, 'critico');
  assert.match(up.cost.reasons.map((x) => x.text).join(' '), /1 → 3/);
  const down = risk(entry('OCR_webscraper_crawler/deploy/router.sh', 'x --min-instances=3\n', 'x --min-instances=1\n'));
  assert.notEqual(down.cost.level, 'critico');
  const fnOpt = risk(entry('functions/src/features/posts.ts', 'export const f = onCall({}, h);\n', 'export const f = onCall({ minInstances: 2 }, h);\n'));
  assert.equal(fnOpt.cost.level, 'critico');
});

test('custo: agendamento mais frequente é crítico; menos frequente não', () => {
  const more = risk(entry('backend/deploy/jobs/schedules.sh', 'SCHEDULE="0 */12 * * *"\n', 'SCHEDULE="*/5 * * * *"\n'));
  assert.equal(more.cost.level, 'critico');
  const less = risk(entry('backend/deploy/jobs/schedules.sh', 'SCHEDULE="*/5 * * * *"\n', 'SCHEDULE="0 3 * * *"\n'));
  assert.equal(less.cost.level, 'baixo');
});

test('custo: nova chamada paga é alta; mover a chamada não é (líquido)', () => {
  const call = "const r = await model.generateContent(prompt);\n";
  assert.equal(risk(entry('OCR_webscraper_crawler/packages/structurer/src/gemini.ts', 'x\n', 'x\n' + call)).cost.level, 'alto');
  assert.equal(risk(entry('OCR_webscraper_crawler/packages/structurer/src/gemini.ts', call + 'x\n', 'x\n' + call)).cost.level, 'baixo');
});

test('custo: novo listener no app é médio; novo trigger Firestore é alto', () => {
  assert.equal(risk(entry('lib/features/feed/data/feed_repository.dart', 'a\n', 'a\nfinal s = col.snapshots();\n')).cost.level, 'medio');
  assert.equal(risk(entry('functions/src/features/posts.ts', 'a\n', "a\nexport const t = onDocumentWritten('posts/{id}', h);\n")).cost.level, 'alto');
});

test('modificadores: diff grande e 3+ camadas sobem um nível (uma vez só)', () => {
  const big = Array.from({ length: 500 }, (_, i) => `l${i}`).join('\n');
  assert.equal(risk(entry('functions/src/features/posts.ts', null, big)).breakage.level, 'alto');
  const three = risk(
    entry('functions/src/features/a.ts', 'a\n', 'b\n'),
    entry('lib/features/feed/data/r.dart', 'a\n', 'b\n'),
    entry('OCR_webscraper_crawler/packages/cache/src/a.ts', 'a\n', 'b\n'),
    entry('functions/src/features/b.ts', null, big),
  );
  assert.equal(three.breakage.level, 'alto');
  assert.equal(risk(entry('lib/features/feed/presentation/p.dart', 'a\n', 'b\n'), entry('test/features/feed/feed_test.dart', 'x\n', null)).breakage.level, 'medio');
});

test('runsPerDay: expressões cron comuns', () => {
  assert.equal(runsPerDay('*/5 * * * *'), 288);
  assert.equal(runsPerDay('0 */12 * * *'), 2);
  assert.equal(runsPerDay('0 3 * * *'), 1);
  assert.equal(runsPerDay('0 9 * * 1-5'), 5 / 7);
  assert.equal(runsPerDay('every 10 minutes'), 144);
  assert.equal(runsPerDay('não é cron'), null);
});
