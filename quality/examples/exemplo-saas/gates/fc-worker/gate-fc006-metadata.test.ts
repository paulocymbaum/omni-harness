// Gates FC-006 no nível do worker — selo IA nos metadados (PNG iTXt + XMP). Template: copiado para src/ pelo gate fc-006.
// Sem Postgres: teste puro de bytes. O mesmo PNG de entrada tem que produzir sempre o mesmo PNG selado (o XMP é constante,
// sem data), e o leitor tem que recuperar o selo — o teste de CI do desenho lê o arquivo gerado e falha se o campo não estiver lá.
import { describe, expect, it } from 'vitest';

import { CREATOR_TOOL, DIGITAL_SOURCE_TYPE, crc32, embedCreatorMetadata, readXmpPacket } from './render/metadata.js';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const TYPE = (name: string): Uint8Array => Uint8Array.from(name, (c) => c.charCodeAt(0));

/** Chunk PNG real: length + type + data + CRC32(type|data). Serve para montar PNGs sintéticos e conferir o do selo. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(TYPE(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** PNG sintético: assinatura + IHDR (13 bytes de dados) + [+tEXt] + IEND. Os testes de metadados só percorrem chunks. */
function syntheticPng(extra?: { type: string; data: Uint8Array }): Uint8Array {
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 1080);
  new DataView(ihdr.buffer).setUint32(4, 1080);
  const parts = [Uint8Array.from(SIGNATURE), chunk('IHDR', ihdr)];
  if (extra) parts.push(chunk(extra.type, extra.data));
  parts.push(chunk('IEND', new Uint8Array(0)));
  return parts.reduce((all, part) => { const out = new Uint8Array(all.length + part.length); out.set(all); out.set(part, all.length); return out; }, new Uint8Array(0));
}

/** Percorre os chunks e confere o CRC32 de cada um (assinatura da integridade estrutural). */
function walk(png: Uint8Array): Array<{ type: string; length: number }> {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const list: Array<{ type: string; length: number }> = [];
  expect([...png.subarray(0, 8)]).toEqual(SIGNATURE);
  for (let at = 8; at < png.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    expect(view.getUint32(at + 8 + length)).toBe(crc32(png.subarray(at + 4, at + 8 + length)));
    list.push({ type, length });
    at += 12 + length;
  }
  return list;
}

describe('FC-006 selo IA nos metadados do PNG', () => {
  it('grava CreatorTool "Fluxo Creators" e o DigitalSourceType IPTC num iTXt XMP legível de volta', () => {
    const sealed = embedCreatorMetadata(syntheticPng());
    const xmp = readXmpPacket(sealed);
    expect(xmp).not.toBeNull(); // só acha o pacote se o iTXt estiver com a keyword XML:com.adobe.xmp
    expect(xmp).toContain(`<xmp:CreatorTool>${CREATOR_TOOL}</xmp:CreatorTool>`);
    expect(xmp).toContain(`<Iptc4xmpExt:DigitalSourceType>${DIGITAL_SOURCE_TYPE}</Iptc4xmpExt:DigitalSourceType>`);
    expect(CREATOR_TOOL).toBe('Fluxo Creators');
    expect(DIGITAL_SOURCE_TYPE).toContain('compositeWithTrainedAlgorithmicMedia');
  });

  it('é determinístico: mesma entrada duas vezes -> mesmos bytes, e o XMP não carrega data nem id de job', () => {
    const png = syntheticPng();
    expect([...embedCreatorMetadata(png)]).toEqual([...embedCreatorMetadata(png)]);
    const xmp = readXmpPacket(embedCreatorMetadata(png)) as string;
    expect(xmp).not.toMatch(/MetadataDate|CreateDate|ModifyDate|xmpMM:/i);
    expect(xmp).not.toMatch(/job|business/i);
  });

  it('é idempotente: selar duas vezes produz um único chunk XMP e os mesmos bytes de selar uma', () => {
    const png = syntheticPng();
    const once = embedCreatorMetadata(png);
    const twice = embedCreatorMetadata(once);
    expect([...once]).toEqual([...twice]);
    expect(walk(twice).filter((c) => c.type === 'iTXt')).toHaveLength(1);
  });

  it('mantém a estrutura do PNG: assinatura, IHDR primeiro, selo depois dele, IEND por último, CRC de todo chunk válido', () => {
    const withText = embedCreatorMetadata(syntheticPng({ type: 'tEXt', data: Uint8Array.from('Software\0fluxo', (c) => c.charCodeAt(0)) }));
    const types = walk(withText).map((c) => c.type);
    expect(types[0]).toBe('IHDR');
    expect(types[1]).toBe('iTXt');
    expect(types[types.length - 1]).toBe('IEND');
    expect(types).toContain('tEXt');
    // e o chunk alheio sobe intacto com o selo
    expect(readXmpPacket(embedCreatorMetadata(withText))).toContain(CREATOR_TOOL);
  });

  it('recusa bytes que não são PNG (assinatura inválida ou truncado)', () => {
    expect(() => embedCreatorMetadata(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]))).toThrow();
    expect(() => embedCreatorMetadata(new Uint8Array(0))).toThrow();
    expect(readXmpPacket(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]))).toBeNull();
  });
});
