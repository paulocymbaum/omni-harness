// Gate de entrega CS-007/CS-008: UI do editor do Creator (segmentos em accordion, prévia do SVG funcionando,
// campos "O que"/"Como", cores do kit no HTML, template sempre no formato) e a logo do kit no PNG por URL
// assinada (o payload do job tem teto de 64 KB e base64 de imagem não cabe nele).
// Estático de propósito: lê as três camadas (web, backend, worker) e os testes que provam o contrato.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { exists, read, stripComments } from './fc-gate-helper.mjs';

const WEB = 'ofluxo_site/src/platform';
const BACKEND = 'backend/src/Fluxo.Api/Modules/Creator';
const WORKER = 'services/creator-worker/src';

describe('Creator: UI do editor e logo no PNG', () => {
  it('CS-007 web: prévia monta com paleta neutra, mostra o SVG no card e sem lista de segmentos', () => {
    const editor = stripComments(read(`${WEB}/domain/creator-editor.ts`));
    assert.match(editor, /export const PREVIEW_FALLBACK_PALETTE = \['#111827', '#F9FAFB'\] as const;/);
    assert.match(editor, /export function creatorPreviewPalette\(palette: readonly string\[\]\): string\[\] \{/);
    assert.match(editor, /const palette = creatorPreviewPalette\(input\.palette\);/);
    assert.match(editor, /export function creatorPaletteVars\(colors: readonly CreatorPaletteColor\[\]\): Record<string, string>/);

    const preview = stripComments(read(`${WEB}/presentation/pages/business/business-creator-preview.tsx`));
    assert.match(preview, /className="fluxo-creator-preview-frame"/);
    // Segmentos em accordion saíram (a imagem já mostra o texto): nada de lista abaixo da prévia.
    assert.doesNotMatch(preview, /PreviewSegments|fluxo-creator-segment/);
    // A composição é HTML de verdade: a árvore do render montada no DOM (nada de SVG injetado).
    assert.match(preview, /<CreatorPreviewCanvas spec=\{canvas\.spec\} layout=\{canvas\.layout\} \/>/);
    assert.doesNotMatch(preview, /dangerouslySetInnerHTML/);
    const canvas = stripComments(read(`${WEB}/presentation/pages/business/creator-preview-canvas.tsx`));
    assert.match(canvas, /className="fluxo-creator-preview-html"/);
    assert.match(canvas, /<Slide spec=\{spec\} layout=\{layout\} \/>/);
    // Fase de erro traduzida: nenhum código cru do pacote chega ao usuário.
    assert.match(stripComments(read(`${WEB}/presentation/pages/business/creator-compose.ts`)), /palette_size/);

    const css = stripComments(read(`${WEB}/presentation/styles/platform.css`));
    for (const cls of ['.fluxo-creator-preview-html {', '.fluxo-creator-templates img {']) {
      assert.ok(css.includes(cls), `platform.css sem ${cls}`);
    }
    const unit = read(`${WEB}/domain/creator-editor.test.ts`);
    assert.match(unit, /kit sem paleta cai na paleta neutra da prévia/);
    assert.match(unit, /variáveis CSS do HTML usam as cores do kit por papel/);
  });

  it('CS-007 web: "O que" e "Como" compõem o prompt único e as cores do kit entram no HTML', () => {
    const message = stripComments(read(`${WEB}/presentation/pages/business/use-creator-message.ts`));
    assert.match(message, /export function useCreatorMessage\(maxChars: number\)/);
    assert.match(message, /const prompt = composeCreatorPrompt\(what, how\);/);
    assert.match(message, /const ready = prompt\.length > 0 && prompt\.length <= maxChars;/);

    const steps = stripComments(read(`${WEB}/presentation/pages/business/business-creator-steps.tsx`));
    assert.match(steps, /O que comunicar/);
    assert.match(steps, /Como comunicar \(opcional\)/);
    assert.match(steps, /export type CreatorMessageFields = \{/);

    const editor = stripComments(read(`${WEB}/presentation/pages/business/business-creator-editor.tsx`));
    assert.match(editor, /const message = useCreatorMessage\(limits\.promptMaxChars\);/);
    assert.match(editor, /message=\{message\.fields\}/);

    const view = stripComments(read(`${WEB}/presentation/pages/business/business-creator-view.tsx`));
    assert.match(view, /style=\{creatorPaletteVars\(kitColorRoles\(brand\.kit\.colors\)\)\}/);
    assert.match(view, /fields=\{props\.message\}/);
  });

  it('CS-007 web: template grava o formato escolhido e a arte aparece recortada nele', () => {
    const brand = stripComments(read(`${WEB}/presentation/pages/business/business-creator-brand.tsx`));
    assert.match(brand, /function TemplatesEditor\(props: TemplatesEditorProps\)/);
    assert.match(brand, /onPick\(file, preset\)/);
    assert.match(brand, /aspectRatio: aspectOf\(viewportPresets, template\.preset\)/);
    assert.match(brand, /Formato do template/);

    const view = stripComments(read(`${WEB}/presentation/pages/business/business-creator-view.tsx`));
    assert.match(view, /<BusinessCreatorBrand \{\.\.\.brand\} \/>/);
    assert.ok(exists(`${WEB}/presentation/pages/business/business-creator-brand.tsx`));
    // O kit salvo na nuvem não é mais escrito: a arte e o formato ficam no navegador (CS-009).
    assert.doesNotMatch(stripComments(read(`${WEB}/infrastructure/creator-api.ts`)), /brand-kit\/templates/);
  });
});

describe('Creator: logo do kit no PNG', () => {
  it('CS-008 backend: o render leva a logo do kit por URL assinada (nunca base64 no payload de 64 KB)', () => {
    const watermark = stripComments(read(`${BACKEND}/Application/CreatorRenderWatermark.cs`));
    assert.match(watermark, /public sealed class CreatorRenderWatermark\(ICreatorAssetStorage storage, IOptions<CreatorOptions> options,/);
    assert.match(watermark, /public const int UrlMinutes = 60;/);
    assert.match(watermark, /\["url"\] = input\.Url,/);
    assert.match(watermark, /\["corner"\] = input\.Corner\.ToWire\(\),/);
    assert.match(watermark, /private static double Unit\(double value\)/);

    const spec = stripComments(read(`${BACKEND}/Application/CreatorRenderSpec.cs`));
    assert.match(spec, /public static string RenderPayload\(Guid projectId, object spec, object\? watermark, object\? template = null\)/);
    assert.match(spec, /payload\["templateImage"\] = template/);
    assert.match(spec, /payload\["watermarkImage"\] = watermark/);

    const service = stripComments(read(`${BACKEND}/Application/CreatorProjectService.cs`));
    assert.match(service, /CreatorRenderWatermark renderWatermark/);
    assert.match(service, /var watermark = await renderWatermark\.ForAsync\(db, businessId, ct\);/);
    assert.match(service, /CreatorRenderSpec\.RenderPayload\(project\.Id, spec, watermark, template\)/);

    const module = read(`${BACKEND}/CreatorModule.cs`);
    assert.match(module, /services\.AddScoped<CreatorRenderWatermark>\(\);/);

    const tests = read('backend/tests/Fluxo.Api.Tests/CreatorRenderWatermarkTests.cs');
    assert.equal((tests.match(/\[Fact\]/g) ?? []).length, 4, 'CreatorRenderWatermarkTests precisa cobrir os 4 caminhos');
    assert.match(tests, /RenderPayload_without_logo_omits_the_watermark_envelope/);
  });

  it('CS-008 worker: baixa a logo por URL assinada e segue sem ela quando o download falha', () => {
    const render = stripComments(read(`${WORKER}/handlers/render.ts`));
    assert.match(render, /export type ImageDownloader = \(url: string\) => Promise<Uint8Array>;/);
    assert.match(render, /export const CREATOR_ASSET_HOST = 'storage\.googleapis\.com';/);
    assert.match(render, /parsed\.protocol !== 'https:' \|\| parsed\.hostname !== CREATOR_ASSET_HOST/);
    assert.match(render, /async function watermarkOrUndefined/);
    assert.match(render, /render_watermark_skipped/);
    assert.match(render, /const watermark = await watermarkOrUndefined\(watermarkImage, downloadImage\);/);
    assert.match(render, /downloadImage = downloadImageBytes/);

    const unit = read(`${WORKER}/handlers/render.test.ts`);
    assert.match(unit, /baixa a logo por URL assinada e injeta a marca no spec/);
    assert.match(unit, /logo indisponível \(download falha\) não derruba o PNG/);
    assert.match(unit, /só aceita HTTPS no bucket do Creator/);
  });
});
