// Gates FC-003-CONTRASTE e FC-003-PALETA-PAPEIS (template; copiado para packages/creator-render/test/).
// Formas fixadas pelo gate: adjustForegroundLightness(fg, bg, target = 4.5) -> { color, ratioBefore, ratioAfter, adjusted, direction };
// resolvePalette(colors) -> { pairA: { background, text }, pairB: { background, text }, accent };
// paletteReport(colors) -> array de { pair: 'a' | 'b' | ..., ratio, level } (um item 'a' sempre; 'b' quando a paleta tem 4 ou 5 cores).
import * as brand from '../src/policy/brand.js';
import { describe, expect, it } from 'vitest';

import {
  CONTRAST_GOOD, CONTRAST_WARN, adjustForegroundLightness, classifyContrast, contrastRatio, paletteReport, resolvePalette,
} from '../src/index.js';
import { codeOf } from './gate-fc003-support.js';

const hsl = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const l = (max + min) / 2; const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
};
const upper = (hex: string) => hex.toUpperCase();
const grays = Array.from({ length: 16 }, (_, i) => `#${(i * 17).toString(16).padStart(2, '0').repeat(3)}`.toUpperCase());
const colored = ['#B53D22', '#1D6E73', '#E39A80', '#86B7B5', '#3A7BD5', '#FFEE00', '#6A1B9A'];
const backgrounds = [...grays, ...colored, '#FFFFFF', '#000000', '#17242B', '#F7F3EC'];
const foregrounds = ['#CCCCCC', '#777777', '#808080', '#3A7BD5', '#FF0000', '#0099FF', '#FFEE00', '#B2B2B2', '#17242B', '#F7F3EC'];

describe('FC-003 contraste: razão, classificação e ajuste só de luminosidade', () => {
  it('valores WCAG conhecidos, simétricos e sem arredondar no cálculo de decisão', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 10);
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 10);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 10);
    expect(contrastRatio('#336699', '#336699')).toBeCloseTo(1, 10);
    expect(contrastRatio('#767676', '#FFFFFF')).toBeCloseTo(4.542224959605253, 9);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.478089453577214, 9);
    expect(contrastRatio('#0099FF', '#FFFFFF')).toBeCloseTo(2.99978868018584, 9);
    expect(contrastRatio('#FFF', '#000')).toBeCloseTo(21, 10);
    expect(contrastRatio('#fff', '#000000')).toBeCloseTo(21, 10);
    expect(contrastRatio('#F7F3EC', '#17242B')).toBeCloseTo(14.34372169557596, 9);
  });

  it('cor inválida lança invalid_color', () => {
    for (const bad of ['red', '#GGGGGG', '#12345', '#1234567', '#FFFFFFFF', '', 'FFFFFF', '#FFF0']) {
      expect(codeOf(() => contrastRatio(bad, '#FFFFFF')), `fg ${bad}`).toBe('invalid_color');
      expect(codeOf(() => contrastRatio('#FFFFFF', bad)), `bg ${bad}`).toBe('invalid_color');
    }
  });

  it('limiares nomeados 4,5 e 3, e classificação good, warn e fail', () => {
    expect(CONTRAST_GOOD).toBe(4.5);
    expect(CONTRAST_WARN).toBe(3);
    expect(classifyContrast(21)).toBe('good');
    expect(classifyContrast(4.5)).toBe('good');
    expect(classifyContrast(4.4999)).toBe('warn');
    expect(classifyContrast(3)).toBe('warn');
    expect(classifyContrast(2.9999)).toBe('fail');
    expect(classifyContrast(1)).toBe('fail');
    expect(classifyContrast(contrastRatio('#777777', '#FFFFFF'))).toBe('warn');
  });

  it('o ajuste alcança 4,5 contra fundos de toda a escala de cinza e coloridos, sem mexer em nada além do texto', () => {
    for (const bg of backgrounds) {
      for (const fg of foregrounds) {
        const result = adjustForegroundLightness(fg, bg);
        expect(result.ratioBefore, `${fg} sobre ${bg}`).toBeCloseTo(contrastRatio(fg, bg), 10);
        expect(result.ratioAfter, `${fg} sobre ${bg}`).toBeGreaterThanOrEqual(4.5);
        expect(result.ratioAfter).toBeCloseTo(contrastRatio(result.color, bg), 10);
        expect(result.adjusted).toBe(result.ratioBefore < 4.5);
        if (!result.adjusted) expect(result.color).toBe(fg);
        expect(typeof result.direction).toBe('string');
      }
    }
  });

  it('preserva matiz e saturação do texto quando a cor ajustada não é preto nem branco', () => {
    for (const bg of ['#FFFFFF', '#17242B', '#808080', '#F7F3EC']) {
      for (const fg of ['#3A7BD5', '#FF0000', '#0099FF', '#B53D22']) {
        const result = adjustForegroundLightness(fg, bg);
        if (!result.adjusted || ['#000000', '#FFFFFF'].includes(upper(result.color))) continue;
        const [before, after] = [hsl(fg), hsl(result.color)];
        const dh = Math.min(Math.abs(before.h - after.h), 360 - Math.abs(before.h - after.h));
        expect(dh, `${fg} sobre ${bg}: matiz`).toBeLessThanOrEqual(3);
        expect(Math.abs(before.s - after.s), `${fg} sobre ${bg}: saturação`).toBeLessThanOrEqual(0.08);
      }
    }
  });

  it('vai na direção de menor mudança e tenta a outra quando uma não alcança', () => {
    const onWhite = adjustForegroundLightness('#CCCCCC', '#FFFFFF');
    expect(hsl(onWhite.color).l).toBeLessThan(hsl('#CCCCCC').l);
    const onBlack = adjustForegroundLightness('#333333', '#000000');
    expect(hsl(onBlack.color).l).toBeGreaterThan(hsl('#333333').l);
    const nearWhite = adjustForegroundLightness('#EEEEEE', '#FFFFFF');
    expect(nearWhite.ratioAfter).toBeGreaterThanOrEqual(4.5);
    const mid = adjustForegroundLightness('#7F7F7F', '#7F7F7F');
    expect(mid.adjusted).toBe(true);
    expect(mid.ratioAfter).toBeGreaterThanOrEqual(4.5);
    const small = adjustForegroundLightness('#777777', '#FFFFFF');
    expect(small.ratioAfter).toBeGreaterThanOrEqual(4.5);
    expect(hsl(small.color).l, 'a mudança de 4,48 para 4,5 é a menor possível').toBeGreaterThan(0.3);
  });

  it('é idempotente, determinístico e aceita outro alvo', () => {
    for (const [fg, bg] of [['#CCCCCC', '#FFFFFF'], ['#3A7BD5', '#17242B'], ['#B2B2B2', '#FFFFFF']] as const) {
      const first = adjustForegroundLightness(fg, bg);
      expect(adjustForegroundLightness(fg, bg)).toEqual(first);
      const again = adjustForegroundLightness(first.color, bg);
      expect(again.adjusted).toBe(false);
      expect(again.color).toBe(first.color);
    }
    const relaxed = adjustForegroundLightness('#B2B2B2', '#FFFFFF', 3);
    expect(relaxed.ratioAfter).toBeGreaterThanOrEqual(3);
    expect(relaxed.ratioAfter).toBeLessThan(4.5);
  });

  it('o par do selo de origem passa de 4,5:1 e usa as cores do kit', () => {
    const strings = (value: unknown): string[] => (typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : []);
    const colors = strings({ ...brand }).map(upper);
    expect(colors).toContain('#17242B');
    expect(colors).toContain('#F7F3EC');
    expect(contrastRatio('#F7F3EC', '#17242B')).toBeGreaterThan(4.5);
  });
});

describe('FC-003 paleta-papeis: pares A e B e destaque por quantidade de cores', () => {
  const C = ['#FFFFFF', '#17242B', '#F7F3EC', '#5A2D0C', '#B53D22'];
  const pair = (background: string, text: string) => ({ background, text });
  const roles = (palette: ReturnType<typeof resolvePalette>) => JSON.parse(JSON.stringify(palette)) as Record<string, unknown>;

  it('2 cores: C1 fundo, C2 texto, par B igual ao A e destaque C2', () => {
    expect(roles(resolvePalette(C.slice(0, 2)))).toEqual({ pairA: pair(C[0], C[1]), pairB: pair(C[0], C[1]), accent: C[1] });
  });
  it('3 cores: par B igual ao A e destaque C3', () => {
    expect(roles(resolvePalette(C.slice(0, 3)))).toEqual({ pairA: pair(C[0], C[1]), pairB: pair(C[0], C[1]), accent: C[2] });
  });
  it('4 cores: par B é C3 e C4 e o destaque é o texto do par A', () => {
    expect(roles(resolvePalette(C.slice(0, 4)))).toEqual({ pairA: pair(C[0], C[1]), pairB: pair(C[2], C[3]), accent: C[1] });
  });
  it('5 cores: par B é C3 e C4 e o destaque é C5', () => {
    expect(roles(resolvePalette(C))).toEqual({ pairA: pair(C[0], C[1]), pairB: pair(C[2], C[3]), accent: C[4] });
  });

  it('1 e 6 cores lançam palette_size e cor inválida lança invalid_color', () => {
    for (const run of [(c: string[]) => resolvePalette(c), (c: string[]) => paletteReport(c)]) {
      expect(codeOf(() => run(['#FFFFFF'])), '1 cor').toBe('palette_size');
      expect(codeOf(() => run([...C, '#000000'])), '6 cores').toBe('palette_size');
      expect(codeOf(() => run([])), 'vazia').toBe('palette_size');
      expect(codeOf(() => run(['#FFFFFF', 'azul'])), 'cor inválida').toBe('invalid_color');
    }
  });

  it('o relatório traz razão e nível por par', () => {
    const two = paletteReport(['#FFFFFF', '#777777']) as Array<{ pair: string; ratio: number; level: string }>;
    const a = two.find((entry) => entry.pair === 'a')!;
    expect(a.ratio).toBeCloseTo(4.478089453577214, 6);
    expect(a.level).toBe('warn');
    const five = paletteReport(['#FFFFFF', '#000000', '#F7F3EC', '#E0E0E0', '#B53D22']) as Array<{ pair: string; ratio: number; level: string }>;
    expect(five.find((entry) => entry.pair === 'a')).toMatchObject({ level: 'good' });
    const b = five.find((entry) => entry.pair === 'b')!;
    expect(b.ratio).toBeCloseTo(contrastRatio('#E0E0E0', '#F7F3EC'), 6);
    expect(b.level).toBe('fail');
    expect(five.every((entry) => ['good', 'warn', 'fail'].includes(entry.level))).toBe(true);
    expect((paletteReport(['#FFFFFF', '#000000', '#F7F3EC', '#E0E0E0']) as Array<{ pair: string }>).some((entry) => entry.pair === 'b')).toBe(true);
  });
});
