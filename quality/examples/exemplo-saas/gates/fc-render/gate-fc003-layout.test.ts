// Gate FC-003-LAYOUT (template; copiado para packages/creator-render/test/): motor de layout puro e determinístico.
// computeLayout(spec, measure, policy?) -> { ok: true, viewport, fontScale, balloons: [{ id, role, rect, fontSize, lineHeight, padding, radius, lines }],
//   reserved: [{ kind: 'user_watermark' | 'origin' | 'protected', rect }], warnings }
//   | { ok: false, reason: 'text_too_long', overflow: { requiredHeight, availableHeight, offenders, suggestedMaxChars } } | { ok: false, reason: 'no_free_area' }
// Medidores: o falso (rápido, determinístico) e o real createSatoriMeasurer({ satori, fonts }).
import satori from 'satori';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Slide, computeLayout, createSatoriMeasurer } from '../src/index.js';
import { loadBundledFonts } from '../src/node.js';
import { FONT_LIMITS, VIEWPORTS, baseSpec, fakeMeasurer, imageInput, inside, overlaps, type AnyRecord, type Rect } from './gate-fc003-support.js';

type Balloon = { id: string; role: string; rect: Rect; fontSize: number; lineHeight: number; padding: number; radius: number; lines: number };
type Reserved = { kind: string; rect: Rect };
type Ok = { ok: true; viewport: { width: number; height: number }; fontScale: number; balloons: Balloon[]; reserved: Reserved[]; warnings: unknown[] };
type Failed = { ok: false; reason: string; overflow?: { requiredHeight: number; availableHeight: number; offenders: string[]; suggestedMaxChars: Record<string, number> } };

const rolesOf = (spec: AnyRecord) => Object.fromEntries((spec.balloons as Array<{ text: string; role: string }>).map((b) => [b.text, b.role]));
const run = async (spec: AnyRecord) => {
  const fake = fakeMeasurer(rolesOf(spec));
  return { result: (await computeLayout(spec as never, fake.measure as never)) as Ok | Failed, fake };
};
// Em landscape (largura > altura) o motor escala por min(largura, altura) (FC-018): a 1920x1080, u = 1080/1080 = 1 —
// os mínimos por papel são os mesmos do feed quadrado e os 4 balões passam a caber (antes, com u = largura/1080 = 1,78,
// a pilha mínima era 1002 px, maior que a altura segura inteira). A prova de igualdade com o feed fica no teste próprio.
const stack = (withCta: boolean) => [
  { id: 't', role: 'title', text: 'Título da peça com dado do Pulso' },
  { id: 'd', role: 'data', text: '75,7%', data: { value: '75,7', unit: '%', label: 'Esgoto adequado', source: 'IBGE', year: 2022 } },
  { id: 'b', role: 'body', text: 'Comparação com o estado e com o Brasil, na mesma fonte.' },
  ...(withCta ? [{ id: 'c', role: 'cta', text: 'Veja o mapa completo no Fluxo' }] : []),
];
const sized = (width: number, height: number, extra: AnyRecord = {}, withCta = width <= height) => baseSpec({ viewport: { width, height }, balloons: stack(withCta), ...extra });
const LONG_TEXT = 'Texto longo. '.repeat(60);
const safeBox = (w: number, h: number): Rect => {
  const margin = Math.floor(0.04 * Math.min(w, h));
  return { x: margin, y: margin, width: w - 2 * margin, height: h - 2 * margin };
};

describe('FC-003 layout: invariantes do motor de layout', () => {
  for (const [name, width, height] of VIEWPORTS) {
    it(`${name} (${width}x${height}) com o medidor falso: tudo dentro da área segura, sem sobreposição e fonte nunca abaixo do mínimo escalado`, async () => {
      const spec = sized(width, height, { watermark: { image: imageInput(200, 100), corner: 'bottom_right', scale: 0.15, margin: 0.04, opacity: 0.9 } });
      const { result, fake } = await run(spec);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      const layout = result as Ok;
      const u = Math.min(width, height) / 1080;
      let box = safeBox(width, height);
      if (height / width >= 1.7) box = { ...box, y: Math.max(box.y, Math.round(0.14 * height) - 1), height: Math.min(box.y + box.height, Math.round(0.8 * height) + 1) - Math.max(box.y, Math.round(0.14 * height) - 1) };
      expect(layout.viewport).toEqual({ width, height });
      expect(layout.balloons.map((b) => b.id)).toEqual((spec.balloons as Array<{ id: string }>).map((b) => b.id));
      const forbidden = layout.reserved.map((r) => r.rect);
      for (const balloon of layout.balloons) {
        expect(Object.values(balloon.rect).every(Number.isInteger), `${balloon.id}: px inteiros`).toBe(true);
        expect(inside(balloon.rect, box), `${balloon.id} fora da área segura ${JSON.stringify(box)}: ${JSON.stringify(balloon.rect)}`).toBe(true);
        expect(balloon.rect.width, `${balloon.id}: largura máxima de 88%`).toBeLessThanOrEqual(Math.round(0.88 * width) + 1);
        for (const zone of forbidden) expect(overlaps(balloon.rect, zone), `${balloon.id} sobre zona reservada`).toBe(false);
        const [min, max] = FONT_LIMITS[balloon.role];
        expect(balloon.fontSize, `${balloon.id}: mínimo escalado`).toBeGreaterThanOrEqual(Math.round(min * u));
        expect(balloon.fontSize, `${balloon.id}: máximo escalado`).toBeLessThanOrEqual(Math.round(max * u));
        expect(Number.isInteger(balloon.lineHeight)).toBe(true);
      }
      for (let i = 0; i < layout.balloons.length; i++)
        for (let j = i + 1; j < layout.balloons.length; j++) expect(overlaps(layout.balloons[i].rect, layout.balloons[j].rect), `${i} x ${j}`).toBe(false);
      for (const request of fake.requests) if (request.role) expect(request.fontSize).toBeGreaterThanOrEqual(Math.round(FONT_LIMITS[request.role][0] * u));
    });
  }

  it('landscape 1920x1080 escala pela altura (FC-018): mesmos mínimos do feed e os 4 balões cabem, mesmo sem selo e marca', async () => {
    const landscape = (await run(sized(1920, 1080, {}, true))).result as Ok | Failed;
    const feed = (await run(sized(1080, 1080, {}, true))).result as Ok | Failed;
    // u = min(1920,1080)/1080 = 1: os MÍNIMOS por papel são os do feed (nada inflado pela largura) e o balão
    // mais largo (88% de 1920) nunca tem fonte menor que a do feed.
    expect(landscape.ok).toBe(feed.ok);
    if (landscape.ok && feed.ok) {
      expect((landscape as Ok).fontScale).toBeGreaterThanOrEqual((feed as Ok).fontScale);
      const minFeed = Math.min(...(feed as Ok).balloons.map((b) => b.fontSize));
      for (const balloon of (landscape as Ok).balloons) {
        const [min] = FONT_LIMITS[balloon.role];
        expect(balloon.fontSize, `${balloon.role}: mínimo sem inflar pela largura`).toBeGreaterThanOrEqual(min);
      }
      expect(Math.min(...(landscape as Ok).balloons.map((b) => b.fontSize))).toBe(minFeed);
    }
  });

  it('usa o espaço: texto curto chega ao máximo do papel e texto longo encolhe sem passar do mínimo', async () => {
    const short = baseSpec({ balloons: [{ id: 'b', role: 'body', text: 'Curto.' }] });
    // 'Texto longo. ' x 60 (780 caracteres): a 44 px estoura a altura livre (922 px) e a 24 px (mínimo) ainda cabe. Com x 26 (338
    // caracteres) o texto cabia a 44 px e o teste não provava encolhimento algum.
    const long = baseSpec({ balloons: [{ id: 'b', role: 'body', text: LONG_TEXT }] });
    const [a, b] = [(await run(short)).result as Ok, (await run(long)).result as Ok];
    expect(a.ok && b.ok).toBe(true);
    expect(a.balloons[0].fontSize).toBe(FONT_LIMITS.body[1]);
    expect(b.balloons[0].fontSize).toBeLessThan(a.balloons[0].fontSize);
    expect(b.balloons[0].fontSize).toBeGreaterThanOrEqual(FONT_LIMITS.body[0]);
    expect(b.balloons[0].fontSize, 'encolheu de verdade, mas acima do mínimo (cabe antes de chegar a ele)').toBeGreaterThan(FONT_LIMITS.body[0]);
    // k é o maior que cabe: o texto longo ocupa a área livre quase toda (sobra menos que um passo de 1%).
    expect(b.balloons[0].rect.height).toBeLessThanOrEqual(922);
    expect(b.fontScale).toBeLessThanOrEqual(a.fontScale);
  });

  it('texto que não cabe volta text_too_long com offenders e sugestão, e a fonte nunca desce do mínimo', async () => {
    const spec = baseSpec({
      balloons: [
        { id: 't', role: 'title', text: 'Título curto' },
        { id: 'b', role: 'body', text: 'Palavra longa demais para caber. '.repeat(120) },
      ],
    });
    const { result, fake } = await run(spec);
    expect(result.ok).toBe(false);
    const failed = result as Failed;
    expect(failed.reason).toBe('text_too_long');
    const overflow = failed.overflow!;
    expect(overflow.requiredHeight).toBeGreaterThan(overflow.availableHeight);
    expect(overflow.offenders).toContain('b');
    expect(overflow.offenders).not.toContain('t');
    expect(overflow.suggestedMaxChars.b).toBeGreaterThan(0);
    expect(overflow.suggestedMaxChars.b).toBeLessThan((spec.balloons as Array<{ text: string }>)[1].text.length);
    for (const request of fake.requests) if (request.role) expect(request.fontSize, 'nunca abaixo do mínimo').toBeGreaterThanOrEqual(FONT_LIMITS[request.role][0]);
  });

  it('região protegida que corta o viewport devolve no_free_area', async () => {
    const { result } = await run(baseSpec({ protectedRegions: [{ x: 0.3, y: 0, width: 0.4, height: 1 }] }));
    expect(result).toMatchObject({ ok: false, reason: 'no_free_area' });
  });

  it('o selo de origem usa o canto inferior que a marca do usuário não usa e as zonas nunca se sobrepõem', async () => {
    const expected: Record<string, 'right' | 'left'> = { top_left: 'right', top_right: 'right', bottom_left: 'right', bottom_right: 'left' };
    for (const [corner, side] of Object.entries(expected)) {
      const spec = baseSpec({ watermark: { image: imageInput(200, 100), corner, scale: 0.2, margin: 0.03, opacity: 0.8 } });
      const layout = (await run(spec)).result as Ok;
      expect(layout.ok, corner).toBe(true);
      const mark = layout.reserved.find((r) => r.kind === 'user_watermark')!;
      const origin = layout.reserved.find((r) => r.kind === 'origin')!;
      expect(mark, corner).toBeDefined();
      expect(origin, corner).toBeDefined();
      expect(overlaps(mark.rect, origin.rect), `${corner}: marca e selo sobrepostos`).toBe(false);
      expect(Math.abs(mark.rect.width - Math.round(0.2 * 1080)), 'escala é fração da largura').toBeLessThanOrEqual(2);
      expect(Math.abs(mark.rect.height * 2 - mark.rect.width), 'proporção da imagem').toBeLessThanOrEqual(3);
      expect(origin.rect.y + origin.rect.height / 2, `${corner}: selo no terço inferior`).toBeGreaterThan(1080 * 0.66);
      const center = origin.rect.x + origin.rect.width / 2;
      expect(side === 'right' ? center > 540 : center < 540, `${corner}: selo no canto inferior ${side}`).toBe(true);
      expect(corner.endsWith('left') ? mark.rect.x + mark.rect.width / 2 < 540 : mark.rect.x + mark.rect.width / 2 > 540).toBe(true);
    }
    const none = (await run(baseSpec())).result as Ok;
    expect(none.reserved.some((r) => r.kind === 'origin')).toBe(true);
    expect(none.reserved.some((r) => r.kind === 'user_watermark')).toBe(false);
  });

  it('regiões protegidas viram zona reservada e nenhum balão as cobre', async () => {
    const spec = baseSpec({ protectedRegions: [{ x: 0.05, y: 0.05, width: 0.3, height: 0.3 }] });
    const layout = (await run(spec)).result as Ok;
    expect(layout.ok).toBe(true);
    const zone = layout.reserved.find((r) => r.kind === 'protected')!;
    expect(zone.rect).toMatchObject({ x: 54, y: 54, width: 324, height: 324 });
    for (const balloon of layout.balloons) expect(overlaps(balloon.rect, zone.rect)).toBe(false);
  });

  it('mesma entrada, mesmo resultado, sem aleatoriedade', async () => {
    const spec = sized(1080, 1350, { watermark: { image: imageInput(200, 100), corner: 'bottom_left', scale: 0.1, margin: 0.04, opacity: 1 } });
    const random = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Math.random proibido no layout'); });
    try {
      const first = JSON.stringify((await run(spec)).result);
      const second = JSON.stringify((await run(spec)).result);
      expect(second).toBe(first);
    } finally { random.mockRestore(); }
  });
});

describe('FC-003 layout: medidor Satori real', () => {
  it('em 6 viewports a altura medida de cada balão é a do nó no render final, e nada estoura', async () => {
    const fonts = await loadBundledFonts();
    const measure = createSatoriMeasurer({ satori, fonts } as never);
    const visited: string[] = [];
    for (const [name, width, height] of VIEWPORTS.filter(([n]) => n !== 'max_4096')) {
      visited.push(name);
      const spec = sized(width, height);
      const layout = (await computeLayout(spec as never, measure as never)) as Ok | Failed;
      expect(layout.ok, `${name}: ${JSON.stringify(layout)}`).toBe(true);
      const ok = layout as Ok;
      const nodes: Array<{ textContent?: string; height: number }> = [];
      await satori(createElement(Slide as never, { spec, layout: ok, fonts }) as never, { width, height, fonts, onNodeDetected: (n: never) => nodes.push(n), onStyleError: (m: string) => { throw new Error(m); } } as never);
      for (const balloon of ok.balloons.filter((b) => ['title', 'body'].includes(b.role))) {
        const text = (spec.balloons as Array<{ id: string; text: string }>).find((b) => b.id === balloon.id)!.text;
        const node = nodes.find((n) => n.textContent === text);
        expect(node, `${name}/${balloon.id}: nó de texto não encontrado entre ${nodes.length} nós`).toBeDefined();
        expect(node!.height, `${name}/${balloon.id}`).toBe(balloon.rect.height - 2 * balloon.padding);
      }
    }
    // O loop não pode abortar no landscape e deixar custom_320 sem rodar: os 5 viewports medidos (4096 vem abaixo) passam por aqui.
    expect(visited).toEqual(['feed_square', 'feed_portrait', 'story', 'landscape', 'custom_320']);
    const huge = (await computeLayout(sized(4096, 4096) as never, measure as never)) as Ok | Failed;
    expect(huge.ok).toBe(true);
  }, 60_000);

  it('medidor real: landscape com 4 balões tem o mesmo desfecho do feed (FC-018) e texto longo encolhe entre o mínimo e o máximo', async () => {
    const fonts = await loadBundledFonts();
    const measure = createSatoriMeasurer({ satori, fonts } as never);
    const landscape = (await computeLayout(sized(1920, 1080, {}, true) as never, measure as never)) as Ok | Failed;
    const feed = (await computeLayout(sized(1080, 1080, {}, true) as never, measure as never)) as Ok | Failed;
    expect(landscape.ok).toBe(feed.ok);
    if (landscape.ok && feed.ok) expect((landscape as Ok).fontScale).toBeGreaterThanOrEqual((feed as Ok).fontScale);
    const short = (await computeLayout(baseSpec({ balloons: [{ id: 'b', role: 'body', text: 'Curto.' }] }) as never, measure as never)) as Ok;
    const long = (await computeLayout(baseSpec({ balloons: [{ id: 'b', role: 'body', text: LONG_TEXT }] }) as never, measure as never)) as Ok;
    expect(short.balloons[0].fontSize).toBe(FONT_LIMITS.body[1]);
    expect(long.ok).toBe(true);
    expect(long.balloons[0].fontSize).toBeLessThan(FONT_LIMITS.body[1]);
    expect(long.balloons[0].fontSize).toBeGreaterThan(FONT_LIMITS.body[0]);
  }, 30_000);

  it('o medidor real também devolve text_too_long em vez de encolher a fonte', async () => {
    const fonts = await loadBundledFonts();
    const measure = createSatoriMeasurer({ satori, fonts } as never);
    const spec = baseSpec({ balloons: [{ id: 'b', role: 'body', text: 'Palavra longa demais para caber. '.repeat(150) }] });
    const layout = (await computeLayout(spec as never, measure as never)) as Failed;
    expect(layout).toMatchObject({ ok: false, reason: 'text_too_long' });
    expect(layout.overflow!.offenders).toEqual(['b']);
  }, 30_000);
});
