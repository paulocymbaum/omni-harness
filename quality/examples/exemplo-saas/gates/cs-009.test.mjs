// Gate de entrega CS-009 (restaurado pela CS-014): a composição final roda NO NAVEGADOR — kit (paleta, logo,
// templates) e PNG ficam só no Cache API; o PNG sai do mesmo SVG da prévia e a única saída é o download. A
// composição no worker (CS-011) foi revertida porque o servidor não tem o kit local.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { exists, read, stripComments } from './fc-gate-helper.mjs';

const WEB = 'ofluxo_site/src/platform';
const BIZ = `${WEB}/presentation/pages/business`;

describe('Creator: composição no navegador (template + logo + cores do kit → PNG local)', () => {
  it('CS-009 kit: paleta, logo e templates vivem no Cache API do navegador', () => {
    const ephemeral = stripComments(read(`${WEB}/infrastructure/creator-ephemeral.ts`));
    assert.match(ephemeral, /const CACHE_NAME = 'fluxo-creator-efemero-v1';/);
    assert.match(ephemeral, /export async function readEphemeral\(key: string\): Promise<Blob \| null>/);
    assert.match(ephemeral, /export async function writeEphemeral\(key: string, blob: Blob\): Promise<void>/);
    assert.match(ephemeral, /export async function dropEphemeral\(prefix: string\): Promise<void>/);

    const hook = stripComments(read(`${BIZ}/use-creator-ephemeral-kit.ts`));
    assert.match(hook, /export function useEphemeralKit\(businessId: string\): EphemeralKitState/);
    assert.match(hook, /const local = await fromCache\(businessId\);/);
    assert.match(hook, /source = local \?\? \(await fromCloud\(businessId\)\);/);
    assert.match(hook, /persist\(businessId,/);
    // Semente é LEITURA: o hook nunca escreve no backend.
    assert.doesNotMatch(hook, /putCreatorPalette|postCreatorAssetUpload|postCreatorTemplate|putCreatorWatermark/);

    const kit = stripComments(read(`${WEB}/domain/creator-kit.ts`));
    assert.match(kit, /export const EMPTY_KIT: EphemeralKit = \{ colors: \[\], logo: null, templates: \[\] \};/);
    assert.match(kit, /export function kitColorRoles/);
    assert.match(kit, /export function kitPairs/);
  });

  it('CS-009 png: o PNG é composto e rasterizado no navegador e a web só baixa', () => {
    const compose = stripComments(read(`${BIZ}/creator-compose.ts`));
    assert.match(compose, /export async function composePiecePng\(businessId: string, input: ComposeInput\): Promise<PieceOutcome>/);
    assert.match(compose, /const blob = await rasterizeSvgToPng\(composed\.svg, input\.viewport\.width, input\.viewport\.height\);/);
    assert.match(compose, /await writeEphemeral\(key, blob\);/);

    const hook = stripComments(read(`${BIZ}/use-ephemeral-piece.ts`));
    assert.match(hook, /export function useEphemeralPiece\(businessId: string, input: ComposeInput\)/);
    assert.match(hook, /composePiecePng\(businessId, current\)/);
    assert.match(hook, /downloadBlob\(piece\.blob/);

    const steps = stripComments(read(`${BIZ}/business-creator-steps.tsx`));
    assert.match(steps, /export function RenderSection\(/);
    assert.match(steps, /Baixar PNG/);
    assert.match(steps, /montada no seu navegador/);
    assert.match(steps, /authoring\.model/);
    assert.match(steps, /authoring\.elapsedMs \/ 1000/);
  });

  it('CS-009 api: a web não pede render ao servidor nem salva a paleta lá', () => {
    assert.equal(exists(`${BIZ}/use-creator-render.ts`), false);
    const api = stripComments(read(`${WEB}/infrastructure/creator-api.ts`));
    assert.doesNotMatch(api, /postCreatorRender|fetchCreatorJobResult|putCreatorPalette/);

    const editor = stripComments(read(`${BIZ}/business-creator-editor.tsx`));
    assert.match(editor, /const piece = useEphemeralPiece\(businessId, composeInput\);/);
    assert.match(editor, /onColors: brandKit\.setColors,/);
    assert.doesNotMatch(editor, /useCreatorRender|putCreatorPalette/);
    // Cores do kit vão como clima no pedido da copy.
    assert.match(editor, /palette: string\[\]/);

    // Sem a etapa "4. Copy": a fila só gera a copy; nada de edição manual nem poll de render duplicado.
    const queue = stripComments(read(`${BIZ}/use-creator-project-queue.ts`));
    assert.doesNotMatch(queue, /saveCopy|setBalloonText|addBalloon/);
    assert.match(queue, /setAuthoring\(copy\.authoring \?\? null\)/);
  });

  it('CS-009 testes: cache, hash e papéis de cor cobertos por unidade', () => {
    const cacheUnit = read(`${WEB}/infrastructure/creator-ephemeral.test.ts`);
    assert.match(cacheUnit, /grava e lê o blob na memória da sessão/);
    assert.match(cacheUnit, /rasterizar fora do navegador falha com código estável/);
    assert.match(cacheUnit, /SVG que o navegador não decodifica vira erro estável/);
    assert.match(cacheUnit, /hash é estável e a chave muda quando o conteúdo muda/);
    const kitUnit = read(`${WEB}/domain/creator-kit.test.ts`);
    assert.match(kitUnit, /pares vêm do cálculo do próprio pacote de render/);
    // A prévia em HTML monta a composição no DOM com o MESMO componente do PNG.
    const previewUnit = read(`${WEB}/presentation/pages/business/business-creator-preview.test.tsx`);
    assert.match(previewUnit, /monta a composição no DOM \(fundo, textos e selo\) em vez de injetar SVG/);
  });
});
