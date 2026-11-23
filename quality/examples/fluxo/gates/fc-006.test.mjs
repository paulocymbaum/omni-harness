// Gates FC-006 — render determinístico no worker, marca d'água de origem e selo IA nos metadados.
// ANTES da implementação cada gate DEVE falhar.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-11-14-fluxo-creator FC-006 --baseline
// Sem Postgres: os gates do worker rodam o Vitest DENTRO de services/creator-worker (templates em quality/test/delivery/fc-worker/,
// padrão FC-004), com npm ci se faltar node_modules. Nunca tocam em services/debate-worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exists, read, runPackageVitest, stripComments } from './fc-gate-helper.mjs';

const WORKER = 'services/creator-worker';
const RENDER = `${WORKER}/src/render`;
const HANDLER = `${WORKER}/src/handlers/render.ts`;
const CONFIG = `${WORKER}/src/config.ts`;
const INDEX = `${WORKER}/src/index.ts`;
const code = (file) => stripComments(read(file));
const vitest = (files, minimum) => runPackageVitest(WORKER, 'fc-worker',
  Object.fromEntries(files.map((f) => [f, `src/${f}`])), minimum);

// ───────────────────────── selo IA nos metadados ─────────────────────────

test('FC-006 metadata: selo IA em iTXt XMP puro (CreatorTool Fluxo Creators + DigitalSourceType IPTC), sem dependência nativa', () => {
  assert.ok(exists(`${RENDER}/metadata.ts`), 'src/render/metadata.ts ausente');
  const meta = code(`${RENDER}/metadata.ts`);
  assert.match(meta, /embedCreatorMetadata/, 'metadata sem embedCreatorMetadata');
  assert.match(meta, /readXmpPacket/, 'metadata sem readXmpPacket (o teste de CI precisa ler o arquivo)');
  assert.match(meta, /Fluxo Creators/, 'metadata sem CreatorTool "Fluxo Creators"');
  assert.match(meta, /compositeWithTrainedAlgorithmicMedia/, 'metadata sem DigitalSourceType composite');
  assert.match(meta, /XML:com\.adobe\.xmp/, 'metadata sem iTXt XML:com.adobe.xmp');
  assert.match(meta, /crc32/i, 'metadata sem CRC32 próprio');
  for (const banned of ['exiftool', "from 'sharp'", 'require\\("sharp"\\)', 'spawnSync', "spawn\\("])
    assert.doesNotMatch(meta, new RegExp(banned), `metadata com dependência nativa/processo: ${banned}`);
  vitest(['gate-fc006-metadata.test.ts'], 5);
});

// ───────────────────────── handler de render/preview ─────────────────────────

test('FC-006 handler: kinds render e preview com o motor do pacote (540 na prévia), store local e códigos de falha próprios', () => {
  assert.ok(exists(HANDLER), 'src/handlers/render.ts ausente');
  assert.ok(exists(`${RENDER}/store.ts`), 'src/render/store.ts ausente');
  const handler = code(HANDLER);
  assert.match(handler, /createRenderJobHandler/, 'handler sem createRenderJobHandler');
  assert.match(handler, /validateRenderSpec/, 'handler sem validateRenderSpec do pacote');
  assert.match(handler, /createNodeRenderer/, 'handler sem createNodeRenderer');
  assert.match(handler, /render_payload_invalid/, 'handler sem render_payload_invalid');
  assert.match(handler, /render_text_too_long/, 'handler sem render_text_too_long');
  assert.match(handler, /render_no_free_area/, 'handler sem render_no_free_area');
  assert.match(handler, /render_style_error/, 'handler sem render_style_error');
  assert.match(handler, /render_store_error/, 'handler sem render_store_error');
  assert.match(handler, /kind === 'preview'|preview/, 'handler sem caminho da prévia');
  assert.match(handler, /540/, 'handler sem largura 540 da prévia');
  const store = code(`${RENDER}/store.ts`);
  assert.match(store, /createLocalResultStore/, 'store sem createLocalResultStore');
  assert.match(store, /rename/, 'store sem escrita atômica (tmp + rename)');
  assert.match(store, /file:\/\//, 'store sem resultRef file://');
  for (const llm of ['anthropic', 'openai', 'Circuit', 'strategy', 'slide_copy'])
    assert.doesNotMatch(handler, new RegExp(llm), `handler de render com dependência de LLM: ${llm}`);
  vitest(['gate-fc006-render.test.ts'], 7);
});

// ───────────────────────── fiação, config e resolução do pacote ─────────────────────────

test('FC-006 fiacao: index registra render+preview, config ganha CREATOR_RENDER_OUTPUT_DIR e o pacote resolve por alias/paths', () => {
  const index = code(INDEX);
  assert.match(index, /createNodeRenderer/, 'index.ts não constrói o renderer');
  assert.match(index, /createRenderJobHandler/, 'index.ts não constrói o handler de render');
  assert.match(index, /render:/, 'index.ts não registra a kind render');
  assert.match(index, /preview:/, 'index.ts não registra a kind preview');
  assert.match(index, /createLocalResultStore/, 'index.ts não constrói o store');
  const config = code(CONFIG);
  assert.match(config, /CREATOR_RENDER_OUTPUT_DIR/, 'config sem CREATOR_RENDER_OUTPUT_DIR');
  assert.match(config, /var\/creator-render/, 'config sem o diretório padrão var/creator-render');
  assert.match(read(`${WORKER}/.env.example`), /CREATOR_RENDER_OUTPUT_DIR/, '.env.example sem CREATOR_RENDER_OUTPUT_DIR');
  assert.match(read(`${WORKER}/README.md`), /CREATOR_RENDER_OUTPUT_DIR/, 'README do worker sem CREATOR_RENDER_OUTPUT_DIR');
  const pkg = JSON.parse(read(`${WORKER}/package.json`));
  assert.ok(pkg.dependencies['@fluxo/creator-render'], 'package.json sem a dependência @fluxo/creator-render');
  assert.match(read(`${WORKER}/vitest.config.ts`), /@fluxo\/creator-render/, 'vitest.config.ts sem alias do pacote');
  assert.match(read(`${WORKER}/esbuild.config.mjs`), /@fluxo\/creator-render/, 'esbuild.config.mjs sem alias do pacote');
  assert.match(read(`${WORKER}/tsconfig.json`), /@fluxo\/creator-render/, 'tsconfig.json sem paths do pacote');
});
