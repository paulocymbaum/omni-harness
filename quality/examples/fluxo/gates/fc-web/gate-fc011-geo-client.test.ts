// Gate FC-011-CLIENTE-WEB (template Vitest, copiado para ofluxo_site/src/platform/domain/ só durante o gate).
// Contratos zod do autocomplete, normalização idêntica à do backend e cliente que obedece aos limites da config.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/platform/infrastructure/firebase', () => ({
  getFluxoFirebase: () => ({ auth: { currentUser: { getIdToken: () => Promise.resolve('token') } }, appCheck: null }),
}));
import { creatorGeoMunicipalityPageSchema, creatorGeoUfPageSchema, normalizeGeoQuery } from './creator-geo';
import { fetchCreatorMunicipalities, fetchCreatorUfs } from '@/platform/infrastructure/creator-geo-api';

const fetchMock = vi.fn<typeof fetch>();
const respond = (body: unknown) => fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => vi.stubGlobal('fetch', fetchMock));
afterEach(() => { vi.unstubAllGlobals(); fetchMock.mockReset(); });

const city = { ibge: '3122306', name: 'Divinópolis', uf: 'MG', porte: { id: 'ate500', label: 'de 100 a 500 mil hab.' } };

describe('FC-011 cliente web: normalização e contratos', () => {
  it('normaliza como o backend: sem acento, minúsculo, hífen e apóstrofo viram espaço', () => {
    expect(normalizeGeoQuery('DIVINÓPOLIS')).toBe('divinopolis');
    expect(normalizeGeoQuery("  Olho d'Água   das Flores ")).toBe('olho d agua das flores');
    expect(normalizeGeoQuery('Xique-Xique')).toBe('xique xique');
    expect(normalizeGeoQuery('São João d’Aliança')).toBe('sao joao d alianca');
    expect(normalizeGeoQuery('')).toBe('');
  });

  it('valida a página de municípios e a de UFs, com nextCursor nulo ou texto', () => {
    expect(creatorGeoMunicipalityPageSchema.parse({ items: [city], nextCursor: 'abc' }).nextCursor).toBe('abc');
    expect(creatorGeoMunicipalityPageSchema.parse({ items: [{ ...city, porte: null }], nextCursor: null }).items[0].porte).toBeNull();
    expect(() => creatorGeoMunicipalityPageSchema.parse({ items: [{ ...city, ibge: 'x' }], nextCursor: null })).toThrow();
    expect(() => creatorGeoMunicipalityPageSchema.parse({ items: [city] })).toThrow();
    expect(creatorGeoUfPageSchema.parse({ items: [{ code: '31', uf: 'MG', name: 'Minas Gerais' }], nextCursor: null }).items[0].uf).toBe('MG');
    expect(() => creatorGeoUfPageSchema.parse({ items: [{ code: '31', uf: 'MG' }], nextCursor: null })).toThrow();
  });
});

describe('FC-011 cliente web: chamadas', () => {
  it('municípios: uf, q, cursor e limit vão na query, e o limit vem do chamador (config), nunca fixo', async () => {
    respond({ items: [city], nextCursor: 'next' });
    const page = await fetchCreatorMunicipalities({ uf: 'MG', q: 'divino', cursor: 'abc', limit: 15 });
    expect(page.items[0].name).toBe('Divinópolis');
    expect(page.nextCursor).toBe('next');
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toMatch(/\/creator\/geo\/municipios$/);
    expect(Object.fromEntries(url.searchParams)).toEqual({ uf: 'MG', q: 'divino', cursor: 'abc', limit: '15' });
    respond({ items: [], nextCursor: null });
    await fetchCreatorMunicipalities({ uf: 'SP', limit: 7 });
    const second = new URL(String(fetchMock.mock.calls[1][0]));
    expect(Object.fromEntries(second.searchParams)).toEqual({ uf: 'SP', limit: '7' });
  });

  it('UFs: q opcional na query', async () => {
    respond({ items: [{ code: '31', uf: 'MG', name: 'Minas Gerais' }], nextCursor: null });
    const page = await fetchCreatorUfs('mi');
    expect(page.items[0].uf).toBe('MG');
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toMatch(/\/creator\/geo\/ufs$/);
    expect(url.searchParams.get('q')).toBe('mi');
  });

  it('o cliente não fixa debounce nem tamanho de página: lê tudo da config', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const file of ['../domain/creator-geo.ts', '../infrastructure/creator-geo-api.ts']) {
      const code = strip(fs.readFileSync(path.resolve(__dirname, file), 'utf8'));
      expect(code, file).not.toMatch(/\b(250|86400)\b/);
      expect(code, file).not.toMatch(/limit\s*[:=]\s*15\b/);
    }
  });
});
