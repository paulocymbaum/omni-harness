// Gates FC-003-RENDER-DETERMINISMO, FC-003-GOLDEN, FC-003-PARIDADE-SVG e FC-003-DESEMPENHO (template; copiado para packages/creator-render/test/).
// Contrato de ligação fixado pelo gate:
//   createSvgRenderer({ satori, fonts }).composeSlide(spec) -> Promise<{ svg, layout, adjustments, warnings }>   (adjustments: { target, pair, from, to, ratioBefore, ratioAfter }[])
//   createNodeRenderer({ fonts? }) -> { renderSvg(spec), renderPng(spec, { width? }) -> Promise<Uint8Array | Buffer> }   (fonts padrão = loadBundledFonts())
//   test/golden/manifest.json = { "cases": [ { "name", "spec": RenderSpec JSON com imagens { base64, mime, width, height }, "expect"?: "text_too_long" } ] }
//   test/golden/<name>.svg (comparação exata) e <name>.png a 540 px de largura (pixelmatch, limiar 0,1, no máximo 0,05% de pixels diferentes).
// O gate nunca define UPDATE_GOLDEN; golden ausente reprova.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import satori from 'satori';
import standalone, { init } from 'satori/standalone';
import { describe, expect, it } from 'vitest';

import { computeLayout, contrastRatio, createSatoriMeasurer, createSvgRenderer } from '../src/index.js';
import { createNodeRenderer, loadBundledFonts } from '../src/node.js';
import { GOLDEN_NAMES, baseSpec, decodeSpec, imageInput, type AnyRecord } from './gate-fc003-support.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(here, '..');
const GOLDEN = path.join(PKG, 'test', 'golden');
const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

type Case = { name: string; spec: AnyRecord; expect?: string };
const manifest = (): Case[] => {
  const file = path.join(GOLDEN, 'manifest.json');
  if (!fs.existsSync(file)) throw new Error('test/golden/manifest.json ausente');
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { cases: Array<Case> }).cases.map((c) => ({ ...c, spec: decodeSpec(c.spec) }));
};
const imageCases = () => manifest().filter((c) => c.expect !== 'text_too_long');
const richSpec = (): AnyRecord => baseSpec({
  viewport: { width: 1080, height: 1350 }, palette: ['#FFFFFF', '#17242B', '#F7F3EC', '#5A2D0C', '#B53D22'],
  background: { kind: 'image', image: imageInput(400, 300), focal: { x: 0.3, y: 0.4 } },
  watermark: { image: imageInput(120, 60, [20, 90, 160]), corner: 'bottom_right', scale: 0.12, margin: 0.04, opacity: 0.9 },
  balloons: [
    { id: 't', role: 'title', text: 'Esgoto adequado em Divinópolis' },
    { id: 'd', role: 'data', text: '92,0%', data: { value: '92,0', unit: '%', label: 'Esgoto adequado', source: 'IBGE Censo 2022', year: 2022 } },
    { id: 'b', role: 'body', text: 'Acima da média de Minas Gerais e do Brasil, segundo o Censo.' },
  ],
});
const pngSize = (data: Uint8Array) => ({ width: Buffer.from(data).readUInt32BE(16), height: Buffer.from(data).readUInt32BE(20) });

describe('FC-003 render-determinismo: mesma spec, mesmos bytes', () => {
  it('SVG e SHA do PNG idênticos em duas execuções, e PNG com a largura e a altura do viewport', async () => {
    const fonts = await loadBundledFonts();
    const node = createNodeRenderer({ fonts } as never);
    const spec = richSpec();
    const [a, b] = [await node.renderSvg(spec as never), await node.renderSvg(spec as never)];
    expect(typeof a === 'string' ? a : (a as { svg: string }).svg).toBe(typeof b === 'string' ? b : (b as { svg: string }).svg);
    const [p1, p2] = [await node.renderPng(spec as never), await node.renderPng(spec as never)];
    expect(sha(p1)).toBe(sha(p2));
    expect(Buffer.from(p1).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(pngSize(p1)).toEqual({ width: 1080, height: 1350 });
  }, 60_000);

  it('fitTo 540 mantém a proporção e a geometria vem do viewport cheio', async () => {
    const node = createNodeRenderer({ fonts: await loadBundledFonts() } as never);
    for (const [w, h] of [[1080, 1350], [1080, 1920], [1920, 1080]]) {
      const spec = baseSpec({ viewport: { width: w, height: h } });
      const small = await node.renderPng(spec as never, { width: 540 });
      expect(pngSize(small)).toEqual({ width: 540, height: Math.round((540 * h) / w) });
    }
  }, 60_000);

  it('processos distintos produzem os mesmos bytes (dist/ construído)', async () => {
    const dist = path.join(PKG, 'dist');
    expect(fs.existsSync(path.join(dist, 'node.js')), 'dist/node.js ausente: rode npm run build').toBe(true);
    const spec = baseSpec({ palette: ['#FFFFFF', '#777777', '#F7F3EC', '#5A2D0C'], viewport: { width: 1080, height: 1350 } });
    const script = `
      import fs from 'node:fs'; import { createHash } from 'node:crypto';
      import { createNodeRenderer, loadBundledFonts } from './dist/node.js';
      const spec = JSON.parse(fs.readFileSync(0, 'utf8'));
      const r = createNodeRenderer({ fonts: await loadBundledFonts() });
      const svg = await r.renderSvg(spec); const png = await r.renderPng(spec, { width: 540 });
      const h = (d) => createHash('sha256').update(d).digest('hex');
      console.log(JSON.stringify({ svg: h(typeof svg === 'string' ? svg : svg.svg), png: h(png) }));`;
    const run = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: PKG, input: JSON.stringify(spec), encoding: 'utf8', timeout: 60_000 }));
    const [one, two] = [run(), run()];
    expect(two).toEqual(one);
    const node = createNodeRenderer({ fonts: await loadBundledFonts() } as never);
    const svg = await node.renderSvg(spec as never);
    expect(sha(typeof svg === 'string' ? svg : (svg as { svg: string }).svg)).toBe(one.svg);
    expect(sha(await node.renderPng(spec as never, { width: 540 }))).toBe(one.png);
  }, 120_000);

  it('o resvg não usa fontes do sistema', () => {
    const source = fs.readFileSync(path.join(PKG, 'src', 'node.ts'), 'utf8');
    expect(source).toMatch(/loadSystemFonts\s*:\s*false/);
    expect(source).not.toMatch(/loadSystemFonts\s*:\s*true/);
  });
});

describe('FC-003 golden: SVG exato e PNG com tolerância, os 8 casos do manifest', () => {
  it('o manifest traz os 8 casos nomeados mais o negativo text_too_long, com a semântica descrita na spec', () => {
    const cases = manifest();
    const names = cases.map((c) => c.name);
    for (const name of GOLDEN_NAMES) expect(names, `caso ${name}`).toContain(name);
    const byName = Object.fromEntries(cases.map((c) => [c.name, c.spec])) as Record<string, AnyRecord>;
    const viewport = (n: string) => byName[n].viewport as { width: number; height: number };
    expect(viewport('feed_square_titulo_corpo')).toEqual({ width: 1080, height: 1080 });
    expect((byName.feed_square_titulo_corpo.palette as string[]).length).toBe(2);
    expect(viewport('feed_portrait_dado')).toEqual({ width: 1080, height: 1350 });
    expect((byName.feed_portrait_dado.palette as string[]).length).toBe(5);
    const data = (byName.feed_portrait_dado.balloons as Array<{ role: string; data?: { source?: string; year?: number } }>).find((b) => b.role === 'data');
    expect(data?.data?.source && data.data.year).toBeTruthy();
    expect(viewport('story_marcas')).toEqual({ width: 1080, height: 1920 });
    expect((byName.story_marcas.watermark as { corner: string }).corner).toBe('bottom_right');
    expect(viewport('landscape')).toEqual({ width: 1920, height: 1080 });
    const bad = byName.contraste_corrigido.palette as string[];
    expect(contrastRatio(bad[1], bad[0])).toBeGreaterThan(1.9);
    expect(contrastRatio(bad[1], bad[0])).toBeLessThan(2.4);
    const background = byName.fundo_imagem_focal.background as { kind: string; focal: { x: number; y: number }; image: { width: number; height: number } };
    expect(background.kind).toBe('image');
    expect(background.image.width / background.image.height).toBeCloseTo(4 / 3, 1);
    expect(background.focal.x === 0.5 && background.focal.y === 0.5).toBe(false);
    expect(viewport('fundo_imagem_focal').width).toBe(viewport('fundo_imagem_focal').height);
    expect((byName.fundo_imagem_focal.protectedRegions as unknown[]).length).toBeGreaterThan(0);
    expect((byName.paleta_3_cores.palette as string[]).length).toBe(3);
    expect(viewport('custom_320')).toEqual({ width: 320, height: 320 });
    expect(cases.filter((c) => c.expect === 'text_too_long').length).toBeGreaterThanOrEqual(1);
  });

  it('o caso contraste_corrigido devolve o ContrastAdjustment e nunca em silêncio', async () => {
    const spec = manifest().find((c) => c.name === 'contraste_corrigido')!.spec;
    const fonts = await loadBundledFonts();
    const result = await createSvgRenderer({ satori, fonts } as never).composeSlide(spec as never) as { adjustments: Array<{ target: string; pair: string; from: string; to: string; ratioBefore: number; ratioAfter: number }> };
    expect(result.adjustments.length).toBeGreaterThanOrEqual(1);
    const first = result.adjustments[0];
    expect(first.target).toMatch(/^balloon:[^:]+:(text|accent)$/);
    expect(['a', 'b']).toContain(first.pair);
    expect(first.from).not.toBe(first.to);
    expect(first.ratioBefore).toBeLessThan(3);
    expect(first.ratioAfter).toBeGreaterThanOrEqual(4.5);
    expect(first.ratioAfter).toBeCloseTo(contrastRatio(first.to, (spec.palette as string[])[0]), 6);
  }, 30_000);

  it('cada caso com imagem tem <caso>.svg exato e <caso>.png de 540 px dentro da tolerância; golden ausente reprova', async () => {
    expect(process.env.UPDATE_GOLDEN, 'o gate nunca define UPDATE_GOLDEN').toBeUndefined();
    const fonts = await loadBundledFonts();
    const svgRenderer = createSvgRenderer({ satori, fonts } as never);
    const node = createNodeRenderer({ fonts } as never);
    for (const c of imageCases()) {
      const svgFile = path.join(GOLDEN, `${c.name}.svg`);
      const pngFile = path.join(GOLDEN, `${c.name}.png`);
      expect(fs.existsSync(svgFile), `golden ausente: ${c.name}.svg`).toBe(true);
      expect(fs.existsSync(pngFile), `golden ausente: ${c.name}.png`).toBe(true);
      const { svg } = await svgRenderer.composeSlide(c.spec as never) as { svg: string };
      expect(svg, `${c.name}: SVG difere do golden`).toBe(fs.readFileSync(svgFile, 'utf8'));
      const expected = PNG.sync.read(fs.readFileSync(pngFile));
      expect(fs.readFileSync(pngFile).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      expect(expected.width, `${c.name}: golden PNG a 540 px`).toBe(540);
      const actual = PNG.sync.read(Buffer.from(await node.renderPng(c.spec as never, { width: 540 })));
      expect([actual.width, actual.height]).toEqual([expected.width, expected.height]);
      const diff = pixelmatch(expected.data, actual.data, undefined, actual.width, actual.height, { threshold: 0.1 });
      expect(diff / (actual.width * actual.height), `${c.name}: pixels diferentes`).toBeLessThanOrEqual(0.0005);
    }
  }, 180_000);

  it('o caso negativo text_too_long não gera imagem e o layout devolve ok:false', async () => {
    const negatives = manifest().filter((c) => c.expect === 'text_too_long');
    expect(negatives.length).toBeGreaterThanOrEqual(1);
    const fonts = await loadBundledFonts();
    const measure = createSatoriMeasurer({ satori, fonts } as never);
    for (const c of negatives) {
      expect(fs.existsSync(path.join(GOLDEN, `${c.name}.svg`)), 'caso negativo não tem imagem').toBe(false);
      expect(fs.existsSync(path.join(GOLDEN, `${c.name}.png`))).toBe(false);
      expect(await computeLayout(c.spec as never, measure as never)).toMatchObject({ ok: false, reason: 'text_too_long' });
    }
  }, 60_000);
});

describe('FC-003 paridade-svg: satori/standalone com layout.wasm gera o mesmo SVG que satori', () => {
  it('byte a byte, para todos os casos golden', async () => {
    const wasm = fs.readFileSync(createRequire(import.meta.url).resolve('satori/layout.wasm'));
    try { await init(await WebAssembly.compile(wasm)); } catch { await (init as (w: unknown) => Promise<void>)(wasm); }
    const fonts = await loadBundledFonts();
    const node = createSvgRenderer({ satori, fonts } as never);
    const browser = createSvgRenderer({ satori: standalone, fonts } as never);
    const cases = imageCases();
    expect(cases.length).toBeGreaterThanOrEqual(8);
    for (const c of cases) {
      const [a, b] = [await node.composeSlide(c.spec as never) as { svg: string }, await browser.composeSlide(c.spec as never) as { svg: string }];
      expect(b.svg, `${c.name}: SVG do caminho do navegador difere`).toBe(a.svg);
    }
  }, 180_000);
});

describe('FC-003 desempenho: folga generosa, números impressos para o FC-005 calibrar a memória', () => {
  it('10 renders PNG de 1080x1350 abaixo de 3000 ms cada, e um 4096x4096 conclui', async () => {
    const node = createNodeRenderer({ fonts: await loadBundledFonts() } as never);
    const spec = richSpec();
    await node.renderPng(spec as never);
    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      const started = performance.now();
      const data = await node.renderPng(spec as never);
      times.push(performance.now() - started);
      expect(pngSize(data)).toEqual({ width: 1080, height: 1350 });
    }
    for (const t of times) expect(t).toBeLessThan(3000);
    const bigStarted = performance.now();
    const big = await node.renderPng(baseSpec({ viewport: { width: 4096, height: 4096 } }) as never);
    const bigMs = performance.now() - bigStarted;
    expect(pngSize(big)).toEqual({ width: 4096, height: 4096 });
    const rssMb = Math.round(process.memoryUsage().rss / 1048576);
    console.info(`FC-003 desempenho: 1080x1350 min/máx ${Math.round(Math.min(...times))}/${Math.round(Math.max(...times))} ms, 4096x4096 ${Math.round(bigMs)} ms, RSS ${rssMb} MiB`);
    expect(bigMs).toBeLessThan(30_000);
  }, 120_000);
});
