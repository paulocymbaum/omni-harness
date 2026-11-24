// Apoio dos gates FC-003 (template; copiado para packages/creator-render/test/ só durante o gate). Constrói RenderSpec, imagens de teste
// válidas (PNG gerado por pngjs, sem sharp), medidor falso e utilidades de geometria. Contrato de ligação fixado pelo gate:
//   src/index.ts (segura para navegador) exporta: contrastRatio, classifyContrast, adjustForegroundLightness, resolvePalette, paletteReport,
//     CONTRAST_GOOD, CONTRAST_WARN, computeLayout, createSatoriMeasurer, createSvgRenderer, validateRenderSpec, RenderSpecError, RENDER_HARD_LIMITS,
//     DEFAULT_LAYOUT_POLICY, CSS_ALLOWLIST, Slide, Balloon, DataBadge, Watermark, OriginBadge
//   src/node.ts exporta: createNodeRenderer, loadBundledFonts
//   Rect = { x, y, width, height } em px inteiros, origem no canto superior esquerdo.
import { PNG } from 'pngjs';

export type AnyRecord = Record<string, unknown>;
export const VIEWPORTS: Array<[string, number, number]> = [
  ['feed_square', 1080, 1080], ['feed_portrait', 1080, 1350], ['story', 1080, 1920], ['landscape', 1920, 1080], ['custom_320', 320, 320], ['max_4096', 4096, 4096],
];
export const GOLDEN_NAMES = [
  'feed_square_titulo_corpo', 'feed_portrait_dado', 'story_marcas', 'landscape', 'contraste_corrigido', 'fundo_imagem_focal', 'paleta_3_cores', 'custom_320',
] as const;
// Mínimos e máximos de fonte a 1080 de largura (spec §5, valores iniciais a validar).
export const FONT_LIMITS: Record<string, [number, number]> = { title: [40, 96], body: [24, 44], data: [40, 120], cta: [28, 48] };

export function png(width: number, height: number, rgb: [number, number, number] = [200, 120, 40]): Uint8Array {
  const image = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    image.data[i * 4] = rgb[0]; image.data[i * 4 + 1] = rgb[1]; image.data[i * 4 + 2] = rgb[2]; image.data[i * 4 + 3] = 255;
  }
  return new Uint8Array(PNG.sync.write(image));
}

export const imageInput = (width: number, height: number, rgb?: [number, number, number]) => ({ bytes: png(width, height, rgb), mime: 'image/png' as const, width, height });

export function baseSpec(over: AnyRecord = {}): AnyRecord {
  return {
    viewport: { width: 1080, height: 1080 },
    background: { kind: 'solid', color: '#F7F3EC' },
    palette: ['#FFFFFF', '#17242B'],
    balloons: [
      { id: 'b1', role: 'title', text: 'Esgoto adequado chega a três em cada quatro moradores' },
      { id: 'b2', role: 'body', text: 'Dado do Censo 2022 para o recorte escolhido, comparado com o estado e com o Brasil.' },
    ],
    origin: { label: 'Feito com' },
    ...over,
  };
}

/** Medidor falso e determinístico. lineHeight < 4 é razão, senão px. Registra cada pedido e o papel do balão pelo texto. */
export function fakeMeasurer(roles: Record<string, string> = {}) {
  const requests: Array<{ text: string; fontSize: number; role?: string; maxWidth: number }> = [];
  const measure = async (req: { text: string; fontSize: number; lineHeight: number; maxWidth: number }) => {
    requests.push({ text: req.text, fontSize: req.fontSize, role: roles[req.text], maxWidth: req.maxWidth });
    const charWidth = req.fontSize * 0.5;
    const perLine = Math.max(1, Math.floor(req.maxWidth / charWidth));
    const lines = Math.max(1, Math.ceil(req.text.length / perLine));
    const lh = req.lineHeight < 4 ? Math.round(req.lineHeight * req.fontSize) : req.lineHeight;
    return { width: Math.min(req.maxWidth, Math.ceil(req.text.length * charWidth)), height: lines * lh, lines };
  };
  return { measure, requests };
}

export type Rect = { x: number; y: number; width: number; height: number };
export const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
export const inside = (inner: Rect, outer: Rect) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

export function codeOf(run: () => unknown): string | undefined {
  try { run(); } catch (error) { return (error as { code?: string }).code ?? `sem-code:${(error as Error).message}`; }
  return undefined;
}

export async function asyncCodeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try { await run(); } catch (error) { return (error as { code?: string }).code ?? `sem-code:${(error as Error).message}`; }
  return undefined;
}

/** Imagens do manifest de golden vêm em JSON: { base64, mime, width, height } vira ImageInput com bytes. */
export function decodeSpec(json: unknown): AnyRecord {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const record = value as AnyRecord;
      if (typeof record.base64 === 'string') {
        const { base64, ...rest } = record;
        return { ...rest, bytes: new Uint8Array(Buffer.from(base64, 'base64')) };
      }
      return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  return walk(json) as AnyRecord;
}
