// Gates FC-006 no nível do worker — handler de render/preview com o motor real (Satori + resvg, fontes embarcadas do pacote)
// e o store local. Sem Postgres: o handler é puro (job -> resultRef); o job é sintético e o store aponta para um diretório
// temporário. Contrato: createRenderJobHandler({ store, previewWidth? }) para as kinds render (viewport cheio) e preview (540).
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { JobFailure, type ClaimedJob } from './handlers/registry.js';
import { createRenderJobHandler } from './handlers/render.js';
import { CREATOR_TOOL, readXmpPacket } from './render/metadata.js';
import { createLocalResultStore } from './render/store.js';

const SPEC = {
  viewport: { width: 1080, height: 1080 },
  background: { kind: 'solid', color: '#101014' },
  palette: ['#101014', '#F5F5F0'],
  balloons: [
    { id: 'titulo', role: 'title', text: 'A renda média subiu no bairro' },
    { id: 'dado', role: 'data', text: 'R$ 2.710', data: { value: 'R$ 2.710', label: 'renda média', source: 'IBGE', year: 2023 } },
  ],
  origin: { label: 'Feito no Fluxo' },
} as const;

const widthOf = (png: Uint8Array): number => new DataView(png.buffer, png.byteOffset, png.byteLength).getUint32(16);
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const job = (kind: 'render' | 'preview', payload: unknown, id = '0196a7e1-0000-7000-8000-000000000001'): ClaimedJob => ({
  id, businessId: 'b', projectId: 'p', slideIndex: null, kind, lane: 'render',
  priority: kind === 'preview' ? 0 : 1, attempts: 1, maxAttempts: 3, deadlineAt: null, payload,
});

let root: string;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'fc006-')); }, 30_000);
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('FC-006 handler de render determinístico', () => {
  it('render final: PNG 1080 no store, resultRef file://<jobId>.png e selo IA legível no arquivo gravado', async () => {
    const store = createLocalResultStore(root);
    const handler = createRenderJobHandler({ store });
    const id = '0196a7e1-0000-7000-8000-000000000002';
    const { resultRef } = await handler({ job: job('render', { spec: SPEC }, id), signal: new AbortController().signal });
    expect(resultRef).toBe(`file://${id}.png`);
    const png = await readFile(join(root, `${id}.png`));
    expect(widthOf(png)).toBe(1080);
    expect(readXmpPacket(png)).toContain(CREATOR_TOOL);
  }, 60_000);

  it('prévia: mesma geometria em 540 px de largura', async () => {
    const store = createLocalResultStore(root);
    const handler = createRenderJobHandler({ store });
    const { resultRef } = await handler({ job: job('preview', { spec: SPEC }), signal: new AbortController().signal });
    expect(widthOf(await readFile(join(root, (resultRef as string).replace('file://', ''))))).toBe(540);
  }, 60_000);

  it('é determinístico: mesma entrada em stores diferentes -> sha256 idêntico', async () => {
    const first = await createRenderJobHandler({ store: createLocalResultStore(root) })({ job: job('render', { spec: SPEC }), signal: new AbortController().signal });
    const second = await createRenderJobHandler({ store: createLocalResultStore(root) })({ job: job('render', { spec: SPEC }, '0196a7e1-0000-7000-8000-000000000003'), signal: new AbortController().signal });
    const a = await readFile(join(root, (first.resultRef as string).replace('file://', '')));
    const b = await readFile(join(root, (second.resultRef as string).replace('file://', '')));
    expect(sha(a)).toBe(sha(b));
  }, 60_000);
});

describe('FC-006 recusas do handler e do store', () => {
  it('recusa origem ausente, background com imagem e marca d\'água que não decodifica, todos sem retentativa', async () => {
    const handler = createRenderJobHandler({ store: createLocalResultStore(root) });
    const signal = new AbortController().signal;
    const noOrigin = { spec: { ...SPEC, origin: undefined } };
    await expect(handler({ job: job('render', noOrigin), signal })).rejects.toMatchObject({ code: 'render_payload_invalid', retryable: false });
    const withImage = { spec: { ...SPEC, background: { kind: 'image', image: { mime: 'image/png', bytes: new Uint8Array(8), width: 8, height: 8 } } } };
    await expect(handler({ job: job('render', withImage), signal })).rejects.toBeInstanceOf(JobFailure);
    const badWatermark = { spec: SPEC, watermarkImage: { mime: 'image/png', base64: '###não-base64###', width: 8, height: 8, corner: 'br', scale: 0.2, margin: 0.04, opacity: 0.9 } };
    await expect(handler({ job: job('render', badWatermark), signal })).rejects.toMatchObject({ code: 'render_payload_invalid' });
  }, 60_000);

  it('texto que não cabe no mínimo legível falha sem retentativa com render_text_too_long', async () => {
    const handler = createRenderJobHandler({ store: createLocalResultStore(root) });
    const long = { spec: { ...SPEC, balloons: [{ id: 'x', role: 'title', text: 'a'.repeat(8000) }] } };
    await expect(handler({ job: job('render', long), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'render_text_too_long', retryable: false });
  }, 60_000);

  it('jobId que tenta sair do diretório do store é recusado (path traversal)', async () => {
    const handler = createRenderJobHandler({ store: createLocalResultStore(root) });
    await expect(handler({ job: job('render', { spec: SPEC }, '../escapou'), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'render_payload_invalid' });
  }, 60_000);

  it('store local devolve ref dentro do root e recusa nome inválido', async () => {
    const store = createLocalResultStore(root);
    const ref = await store.save('0196a7e1-0000-7000-8000-000000000004', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(ref).toMatch(/^file:\/\/0196a7e1-0000-7000-8000-000000000004\.png$/);
    await expect(store.save('../fora', new Uint8Array(8))).rejects.toThrow();
    await expect(store.save('nome/com/barra', new Uint8Array(8))).rejects.toThrow();
  });
});
