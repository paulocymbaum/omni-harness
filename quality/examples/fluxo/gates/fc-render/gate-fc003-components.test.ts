// Gate FC-003-COMPONENTES (template; copiado para packages/creator-render/test/). Renderiza Slide (que usa Balloon, DataBadge, Watermark e
// OriginBadge) pelo Satori com onStyleError estrito e confere, nó a nó (onNodeDetected), o subconjunto de CSS, as famílias de fonte
// registradas, o título em Fluxo Sans 400 e as dimensões do viewport. CSS_ALLOWLIST pode ser array de strings, array de { key | name | property }
// ou record por propriedade; entrada terminada em * (margin*, padding*, border*) vale como prefixo.
import satori from 'satori';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { CSS_ALLOWLIST, Slide, computeLayout } from '../src/index.js';
import { loadBundledFonts } from '../src/node.js';
import { baseSpec, fakeMeasurer, imageInput, type AnyRecord } from './gate-fc003-support.js';

type Node = { type: string; width: number; height: number; textContent?: string; props?: { style?: Record<string, unknown>; src?: string } };

const allowed = (): { exact: Set<string>; prefixes: string[] } => {
  const list = CSS_ALLOWLIST as unknown;
  const names = Array.isArray(list)
    ? list.map((item) => (typeof item === 'string' ? item : String((item as AnyRecord).key ?? (item as AnyRecord).name ?? (item as AnyRecord).property)))
    : Object.keys(list as AnyRecord);
  return { exact: new Set(names.filter((n) => !n.endsWith('*'))), prefixes: names.filter((n) => n.endsWith('*')).map((n) => n.slice(0, -1)) };
};

const richSpec = (): AnyRecord => baseSpec({
  viewport: { width: 1080, height: 1350 },
  background: { kind: 'image', image: imageInput(400, 300), focal: { x: 0.3, y: 0.6 } },
  palette: ['#FFFFFF', '#17242B', '#F7F3EC', '#5A2D0C', '#B53D22'],
  balloons: [
    { id: 't', role: 'title', text: 'Esgoto adequado em Divinópolis' },
    { id: 'd', role: 'data', text: '92,0%', data: { value: '92,0', unit: '%', label: 'Esgoto adequado', source: 'IBGE Censo 2022', year: 2022 } },
    { id: 'b', role: 'body', text: 'Acima da média de Minas Gerais e do Brasil.', pair: 'b' },
    { id: 'c', role: 'cta', text: 'Veja no mapa do Fluxo' },
  ],
  watermark: { image: imageInput(120, 60, [20, 90, 160]), corner: 'top_right', scale: 0.14, margin: 0.04, opacity: 0.7 },
});

async function renderNodes(spec: AnyRecord) {
  const fonts = await loadBundledFonts();
  const fake = fakeMeasurer();
  const layout = await computeLayout(spec as never, fake.measure as never);
  expect((layout as { ok: boolean }).ok, JSON.stringify(layout)).toBe(true);
  const viewport = spec.viewport as { width: number; height: number };
  const nodes: Node[] = [];
  const styleErrors: string[] = [];
  const svg = await satori(createElement(Slide as never, { spec, layout, fonts }) as never, {
    width: viewport.width, height: viewport.height, fonts, onNodeDetected: (n: never) => nodes.push(n), onStyleError: (m: string) => styleErrors.push(m),
  } as never);
  return { svg, nodes, styleErrors, fonts: fonts as Array<{ name: string; weight?: number }> };
}

describe('FC-003 componentes: Slide e filhos no subconjunto de CSS do Satori', () => {
  it('renderiza sem nenhum erro de estilo e a raiz tem as dimensões exatas do viewport', async () => {
    const { svg, nodes, styleErrors } = await renderNodes(richSpec());
    expect(styleErrors).toEqual([]);
    expect(nodes[0]).toMatchObject({ width: 1080, height: 1350 });
    expect(svg).toMatch(/<svg[^>]*width="1080"[^>]*height="1350"/);
  });

  it('nenhuma chave de style fora de CSS_ALLOWLIST, em todos os nós de todos os componentes', async () => {
    const { nodes } = await renderNodes(richSpec());
    const { exact, prefixes } = allowed();
    expect(exact.size + prefixes.length).toBeGreaterThan(30);
    const offenders = new Set<string>();
    for (const node of nodes) for (const key of Object.keys(node.props?.style ?? {})) if (!exact.has(key) && !prefixes.some((p) => key.startsWith(p))) offenders.add(key);
    expect([...offenders], 'chave de CSS fora da allowlist (o Satori a ignoraria em silêncio)').toEqual([]);
    expect(nodes.length).toBeGreaterThan(8);
  });

  it('só famílias registradas, título em Fluxo Sans 400 e corpo em Archivo', async () => {
    const { nodes, fonts } = await renderNodes(richSpec());
    const registered = new Set(fonts.map((f) => f.name));
    expect(registered).toContain('Fluxo Sans');
    expect(registered).toContain('Archivo');
    for (const node of nodes) {
      const family = node.props?.style?.fontFamily;
      if (typeof family === 'string') for (const name of family.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''))) expect(registered.has(name), `família ${name}`).toBe(true);
    }
    const title = nodes.find((n) => n.textContent === 'Esgoto adequado em Divinópolis')!;
    expect(title, 'nó do título').toBeDefined();
    expect(title.props?.style?.fontFamily).toMatch(/Fluxo Sans/);
    expect([undefined, 400, '400', 'normal']).toContain(title.props?.style?.fontWeight);
    const body = nodes.find((n) => n.textContent === 'Acima da média de Minas Gerais e do Brasil.')!;
    expect(body.props?.style?.fontFamily).toMatch(/Archivo/);
    expect(body.props?.style?.display).toBe('block');
    expect(body.props?.style?.overflowWrap).toBe('break-word');
  });

  it('DataBadge traz número, rótulo e rodapé com fonte e ano; OriginBadge traz o logotipo do kit e o rótulo', async () => {
    const { nodes, svg } = await renderNodes(richSpec());
    const texts = nodes.map((n) => n.textContent ?? '');
    expect(texts.some((t) => t.includes('92,0'))).toBe(true);
    expect(texts.some((t) => t.includes('Esgoto adequado') && t !== 'Esgoto adequado em Divinópolis')).toBe(true);
    expect(texts.some((t) => t.includes('IBGE Censo 2022'))).toBe(true);
    expect(texts.some((t) => /2022/.test(t))).toBe(true);
    expect(texts.some((t) => t.includes('Feito com'))).toBe(true);
    expect(svg).toContain('data:image/svg+xml');
    expect(svg).not.toMatch(/<text[\s>]/);
    expect(nodes.filter((n) => n.type === 'img').length).toBeGreaterThanOrEqual(3);
  });

  it('a marca d\'água do usuário respeita a opacidade da entrada', async () => {
    const { nodes } = await renderNodes(richSpec());
    const withOpacity = nodes.filter((n) => n.props?.style?.opacity === 0.7);
    expect(withOpacity.length).toBeGreaterThanOrEqual(1);
  });

  it('as dimensões acompanham o viewport em formatos diferentes', async () => {
    for (const [w, h] of [[1080, 1080], [1920, 1080], [320, 320]]) {
      const { nodes, styleErrors } = await renderNodes(baseSpec({ viewport: { width: w, height: h } }));
      expect(styleErrors).toEqual([]);
      expect(nodes[0]).toMatchObject({ width: w, height: h });
    }
  });
});
