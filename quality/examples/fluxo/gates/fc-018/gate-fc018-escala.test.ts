// Gate FC-018-ESCALA (template; copiado para packages/creator-render/test/): escala do layout por
// min(largura, altura)/1080 (FC-018). Contrato: o CHÃO solicitado por papel (a primeira medida de cada balão,
// no step 0) é round(mínimo do papel × u) com u = min(largura, altura)/1080 — em landscape 1920x1080, u = 1 e o
// chão é o do feed; em ultrawide 2000x1000, u = 1000/1080 e o chão cai; formatos com altura >= largura são
// imunes (min == largura). Os 4 balões cabem em landscape e o motor é determinístico.
// Autossuficiente: spec mínima e medidor falso embutidos (formato segue o RenderSpec validado pelo pacote).
import { describe, expect, it } from 'vitest';

import { computeLayout, type RenderSpec } from '../src/index.js';

const stack = (withCta: boolean) => [
  { id: 't', role: 'title', text: 'Título da peça com dado do Pulso' },
  { id: 'd', role: 'data', text: '75,7%', data: { value: '75,7', unit: '%', label: 'Esgoto adequado', source: 'IBGE', year: 2022 } },
  { id: 'b', role: 'body', text: 'Comparação com o estado e com o Brasil, na mesma fonte.' },
  ...(withCta ? [{ id: 'c', role: 'cta', text: 'Veja o mapa completo no Fluxo' }] : []),
];
const sized = (width: number, height: number): RenderSpec =>
  ({
    viewport: { width, height },
    background: { kind: 'solid', color: '#F7F3EC' },
    palette: ['#FFFFFF', '#17242B'],
    balloons: stack(true),
    origin: { label: 'Feito com' },
  }) as never;

const ROLE_OF: Record<string, string> = {
  'Título da peça com dado do Pulso': 'title',
  '75,7%': 'data',
  'Comparação com o estado e com o Brasil, na mesma fonte.': 'body',
  'Veja o mapa completo no Fluxo': 'cta',
};
const FLOOR: Record<string, number> = { title: 40, data: 40, body: 24, cta: 28 };

const floorOf = (role: string, u: number) => Math.round(FLOOR[role] * u);

/** Roda o layout e devolve o MENOR fontSize solicitado ao medidor (o chão do step 0 é o mínimo possível). */
async function run(width: number, height: number): Promise<{ ok: boolean; fontScale: number; floor: number }> {
  const requests: Array<{ role: string; fontSize: number }> = [];
  const measure = async (req: { text: string; fontSize: number; lineHeight: number; maxWidth: number }) => {
    requests.push({ role: ROLE_OF[req.text] ?? '?', fontSize: req.fontSize });
    const charWidth = req.fontSize * 0.5;
    const perLine = Math.max(1, Math.floor(req.maxWidth / charWidth));
    const lines = Math.max(1, Math.ceil(req.text.length / perLine));
    const lh = req.lineHeight < 4 ? Math.round(req.lineHeight * req.fontSize) : req.lineHeight;
    return { width: Math.min(req.maxWidth, Math.ceil(req.text.length * charWidth)), height: lines * lh, lines };
  };
  const layout = (await computeLayout(sized(width, height), measure)) as { ok: boolean; fontScale: number; balloons: Array<{ role: string; fontSize: number }> };
  expect(layout.ok, `${width}x${height}: ${JSON.stringify(layout)}`).toBe(true);
  const floor = Math.min(...requests.filter((r) => r.role !== '?').map((r) => r.fontSize));
  return { ok: layout.ok, fontScale: layout.fontScale, floor };
}

describe('FC-018 escala por min(largura, altura)/1080', () => {
  it('landscape 1920x1080: chão por papel igual ao do feed (u = 1) e os 4 balões cabem', async () => {
    const feed = await run(1080, 1080);
    const landscape = await run(1920, 1080);
    expect(landscape.floor).toBe(feed.floor); // u = 1 dos dois lados: o chão é o mesmo
    expect(landscape.fontScale).toBeGreaterThanOrEqual(1);
    expect(landscape.floor).toBe(floorOf('body', 1)); // chão da pilha = body 24 (o menor papel)
  });

  it('retrato e story: chão solicitado idêntico ao feed (min == largura)', async () => {
    const feed = await run(1080, 1080);
    for (const [width, height] of [[1080, 1350], [1080, 1920]] as const) {
      const layout = await run(width, height);
      expect(layout.ok, `${width}x${height}`).toBe(true);
      expect(layout.floor).toBe(feed.floor);
    }
  });

  it('320 e 4096 são imunes à troca: o chão segue a fórmula antiga por largura (0,296 e 3,79)', async () => {
    const small = await run(320, 320);
    const huge = await run(4096, 4096);
    expect(small.floor).toBe(floorOf('body', 320 / 1080)); // 7
    expect(huge.floor).toBe(floorOf('body', 4096 / 1080)); // 91: quadrado grande tem min = largura nas duas fórmulas
  });

  it('ultrawide 2000x1000 escala pela altura (u = 1000/1080): chão menor que o feed', async () => {
    const feed = await run(1080, 1080);
    const ultra = await run(2000, 1000);
    expect(ultra.ok).toBe(true);
    expect(ultra.floor).toBe(floorOf('body', 1000 / 1080)); // 22 < 24 do feed
    expect(ultra.floor).toBeLessThan(feed.floor);
  });

  it('determinismo em landscape: mesmo input, mesmo resultado', async () => {
    const first = JSON.stringify(await run(1920, 1080));
    const second = JSON.stringify(await run(1920, 1080));
    expect(second).toBe(first);
  });
});
