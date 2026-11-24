// Gates FC-003-SEGURANCA-IMAGEM e FC-003-VALIDACAO (template; copiado para packages/creator-render/test/).
// validateRenderSpec(spec) lança RenderSpecError com `code` estável. Regra de ligação fixada pelo gate para a URL remota: qualquer ImageInput
// que carregue uma string `src` ou `url` começando por http(s):// é recusado com image_remote_forbidden, mesmo com bytes ao lado (o pacote nunca a repassa ao Satori).
import satori from 'satori';
import { describe, expect, it } from 'vitest';

import { RENDER_HARD_LIMITS, RenderSpecError, createSvgRenderer, validateRenderSpec } from '../src/index.js';
import { loadBundledFonts } from '../src/node.js';
import { asyncCodeOf, baseSpec, codeOf, imageInput, png, type AnyRecord } from './gate-fc003-support.js';

const bytes = (text: string | number[]) => (typeof text === 'string' ? new TextEncoder().encode(text) : new Uint8Array(text));
const webp = bytes('RIFF\u0010\u0000\u0000\u0000WEBPVP8 \u0000\u0000\u0000\u0000');
const gif = bytes('GIF89a\u0001\u0000\u0001\u0000\u0000\u0000;');
const jpeg = bytes([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const withBackground = (image: AnyRecord) => baseSpec({ background: { kind: 'image', image, focal: { x: 0.5, y: 0.5 } } });
const withMark = (image: AnyRecord) => baseSpec({ watermark: { image, corner: 'bottom_right', scale: 0.1, margin: 0.04, opacity: 1 } });
const svgImage = (svg: string): AnyRecord => ({ bytes: bytes(svg), mime: 'image/svg+xml', width: 100, height: 100 });
const SVG = (inner: string, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs} viewBox="0 0 100 100" width="100" height="100">${inner}</svg>`;

describe('FC-003 seguranca-imagem: entrada de imagem em defesa em profundidade', () => {
  it('PNG, JPEG e SVG limpos passam, nos dois lugares em que a imagem entra', () => {
    for (const image of [imageInput(40, 30), { bytes: jpeg, mime: 'image/jpeg', width: 10, height: 10 }, svgImage(SVG('<circle cx="50" cy="50" r="40" fill="#123456"/>'))]) {
      expect(codeOf(() => validateRenderSpec(withBackground(image) as never)), 'fundo').toBeUndefined();
      expect(codeOf(() => validateRenderSpec(withMark(image) as never)), 'marca d\'água').toBeUndefined();
    }
  });

  it('WebP, GIF e bytes inválidos são recusados com image_format_unsupported', () => {
    for (const [why, image] of Object.entries({
      'WebP declarado como WebP': { bytes: webp, mime: 'image/webp', width: 10, height: 10 },
      'WebP declarado como PNG': { bytes: webp, mime: 'image/png', width: 10, height: 10 },
      GIF: { bytes: gif, mime: 'image/png', width: 1, height: 1 },
      'bytes aleatórios': { bytes: bytes([1, 2, 3, 4, 5, 6, 7, 8, 9]), mime: 'image/png', width: 10, height: 10 },
      vazio: { bytes: new Uint8Array(), mime: 'image/png', width: 10, height: 10 },
      'texto': { bytes: bytes('isto não é imagem'), mime: 'image/jpeg', width: 10, height: 10 },
    })) {
      expect(codeOf(() => validateRenderSpec(withBackground(image) as never)), `${why} no fundo`).toBe('image_format_unsupported');
      expect(codeOf(() => validateRenderSpec(withMark(image) as never)), `${why} na marca`).toBe('image_format_unsupported');
    }
  });

  it('mime mentiroso é recusado pelos bytes mágicos', () => {
    const lies = [
      { bytes: png(4, 4), mime: 'image/jpeg', width: 4, height: 4 }, { bytes: jpeg, mime: 'image/png', width: 10, height: 10 },
      { bytes: png(4, 4), mime: 'image/svg+xml', width: 4, height: 4 }, { bytes: bytes(SVG('<rect width="1" height="1"/>')), mime: 'image/png', width: 100, height: 100 },
    ];
    for (const image of lies) expect(['image_format_unsupported', 'svg_unsafe']).toContain(codeOf(() => validateRenderSpec(withBackground(image) as never)));
  });

  it('SVG com conteúdo ativo é recusado com svg_unsafe', () => {
    const unsafe: Record<string, string> = {
      script: SVG('<script>alert(1)</script><rect width="1" height="1"/>'),
      onload: SVG('<rect width="1" height="1"/>', 'onload="alert(1)"'),
      onclick: SVG('<rect width="1" height="1" onclick="x()"/>'),
      foreignObject: SVG('<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>'),
      'css @import': SVG('<style>@import url(http://evil.test/a.css);</style><rect width="1" height="1"/>'),
      'href remoto': SVG('<image href="https://evil.test/a.png" width="10" height="10"/>'),
      'xlink:href remoto': SVG('<use xlink:href="http://evil.test/a.svg#x"/>'),
      'entidade XML': `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]>${SVG('<text>&x;</text>')}`,
    };
    for (const [why, svg] of Object.entries(unsafe)) {
      expect(codeOf(() => validateRenderSpec(withBackground(svgImage(svg)) as never)), `${why} no fundo`).toBe('svg_unsafe');
      expect(codeOf(() => validateRenderSpec(withMark(svgImage(svg)) as never)), `${why} na marca`).toBe('svg_unsafe');
    }
  });

  it('src ou url http(s) é recusado com image_remote_forbidden, e só data URI ou bytes são aceitos', () => {
    for (const key of ['src', 'url']) for (const remote of ['http://example.test/a.png', 'https://example.test/a.png', 'HTTPS://example.test/a.png']) {
      const image = { ...imageInput(10, 10), [key]: remote };
      expect(codeOf(() => validateRenderSpec(withBackground(image) as never)), `${key} ${remote}`).toBe('image_remote_forbidden');
      expect(codeOf(() => validateRenderSpec(withMark(image) as never)), `${key} ${remote} na marca`).toBe('image_remote_forbidden');
    }
    expect(codeOf(() => validateRenderSpec(withBackground({ ...imageInput(10, 10), src: 'data:image/png;base64,AAAA' }) as never))).not.toBe('image_remote_forbidden');
  });

  it('lado acima de 4096 é recusado e o limite técnico é 320..4096', () => {
    expect(RENDER_HARD_LIMITS).toMatchObject({ minSide: 320, maxSide: 4096 });
    const huge = { bytes: png(8, 8), mime: 'image/png', width: 5000, height: 10 };
    expect(codeOf(() => validateRenderSpec(withBackground(huge) as never))).toBeDefined();
    expect(codeOf(() => validateRenderSpec(withMark({ ...huge, width: 10, height: 4097 }) as never))).toBeDefined();
  });
});

describe('FC-003 validacao: códigos de erro estáveis do RenderSpec', () => {
  const code = (spec: AnyRecord) => codeOf(() => validateRenderSpec(spec as never));

  it('spec válida passa e o erro é uma RenderSpecError', () => {
    expect(code(baseSpec())).toBeUndefined();
    let caught: unknown;
    try { validateRenderSpec(baseSpec({ palette: ['#FFFFFF'] }) as never); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(RenderSpecError);
    expect(caught).toBeInstanceOf(Error);
  });

  it('viewport fora de 320..4096, ou não inteiro', () => {
    for (const viewport of [{ width: 319, height: 1080 }, { width: 1080, height: 4097 }, { width: 1080.5, height: 1080 }, { width: 0, height: 0 }, { width: 1080, height: -1 }])
      expect(code(baseSpec({ viewport })), JSON.stringify(viewport)).toBe('viewport_out_of_range');
    expect(code(baseSpec({ viewport: { width: 320, height: 320 } }))).toBeUndefined();
    expect(code(baseSpec({ viewport: { width: 4096, height: 4096 } }))).toBeUndefined();
  });

  it('paleta: tamanho 2..5 e cores #RGB ou #RRGGBB sem alfa', () => {
    expect(code(baseSpec({ palette: ['#FFFFFF'] }))).toBe('palette_size');
    expect(code(baseSpec({ palette: ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666'] }))).toBe('palette_size');
    for (const bad of ['red', '#12345', '#GGGGGG', '#FFFFFF80', 'FFFFFF']) expect(code(baseSpec({ palette: ['#FFFFFF', bad] })), bad).toBe('invalid_color');
    expect(code(baseSpec({ palette: ['#FFF', '#000'] }))).toBeUndefined();
    expect(code(baseSpec({ background: { kind: 'solid', color: 'azul' } }))).toBe('invalid_color');
  });

  it('balões: texto vazio e id repetido', () => {
    expect(code(baseSpec({ balloons: [{ id: 'a', role: 'title', text: '   ' }] }))).toBe('balloon_text_empty');
    expect(code(baseSpec({ balloons: [{ id: 'a', role: 'title', text: 'Um' }, { id: 'a', role: 'body', text: 'Dois' }] }))).toBe('balloon_id_duplicate');
  });

  it('valores fora de 0..1 na marca d\'água e no ponto focal', () => {
    for (const bad of [{ scale: 1.5 }, { scale: -0.1 }, { margin: 2 }, { opacity: -0.1 }, { opacity: 1.01 }])
      expect(code(baseSpec({ watermark: { image: imageInput(10, 10), corner: 'top_left', scale: 0.1, margin: 0.04, opacity: 0.9, ...bad } })), JSON.stringify(bad)).toBe('value_out_of_range');
    expect(code(baseSpec({ background: { kind: 'image', image: imageInput(10, 10), focal: { x: 2, y: 0.5 } } }))).toBe('value_out_of_range');
    expect(code(baseSpec({ watermark: { image: imageInput(10, 10), corner: 'top_left', scale: 0, margin: 0, opacity: 1 } }))).toBeUndefined();
  });

  it('família de fonte não registrada vira font_missing, nunca fallback silencioso', async () => {
    const fonts = (await loadBundledFonts()) as Array<{ name: string }>;
    expect(await asyncCodeOf(async () => {
      const renderer = createSvgRenderer({ satori, fonts: fonts.filter((f) => f.name !== 'Archivo') } as never);
      return renderer.composeSlide(baseSpec() as never);
    })).toBe('font_missing');
  });
});
