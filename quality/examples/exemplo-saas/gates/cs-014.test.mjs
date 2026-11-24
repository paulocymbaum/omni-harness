// Gate de entrega CS-014: o PNG final é composto NO NAVEGADOR (cores, logo e template do kit local). A web não
// chama POST /render nem salva paleta no servidor; o worker só escreve a copy. Rotas do backend permanecem.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { exists, read, stripComments } from './fc-gate-helper.mjs';

const WEB = 'ofluxo_site/src/platform';
const BIZ = `${WEB}/presentation/pages/business`;

describe('Creator: PNG composto no navegador com o kit local', () => {
  it('CS-014 editor: usa useEphemeralPiece e não salva a paleta no servidor', () => {
    const editor = stripComments(read(`${BIZ}/business-creator-editor.tsx`));
    assert.match(editor, /const piece = useEphemeralPiece\(businessId, composeInput\);/);
    assert.match(editor, /composeInputOf\(\{ viewport: viewport \?\? config\.viewportPresets\[0\], kit: brandKit\.kit, watermark, balloons: queue\.balloons, facts \}\)/);
    assert.match(editor, /onColors: brandKit\.setColors,/);
    assert.doesNotMatch(editor, /useCreatorRender|putCreatorPalette/);
  });

  it('CS-014 web: sem caminho do render no servidor', () => {
    assert.equal(exists(`${BIZ}/use-creator-render.ts`), false, 'use-creator-render.ts deve ser removido');
    const api = stripComments(read(`${WEB}/infrastructure/creator-api.ts`));
    assert.doesNotMatch(api, /postCreatorRender|fetchCreatorJobResult|putCreatorPalette/);
  });

  it('CS-014 tela: texto da composição no navegador', () => {
    const steps = stripComments(read(`${BIZ}/business-creator-steps.tsx`));
    assert.match(steps, /A imagem é montada no seu navegador \(template \+ logo \+ cores do kit\) e baixada aqui\./);
    assert.match(steps, /Gerar PNG de novo/);
    assert.match(steps, /authoring\.model/);
    assert.doesNotMatch(steps, /montada no servidor/);
  });

  it('CS-014 backend: rotas do servidor ficam (uso futuro); nada muda no .NET', () => {
    const routes = read('backend/src/Exemplo SaaS.Api/Modules/Creator/CreatorProjectEndpoints.cs');
    assert.match(routes, /\/render/);
  });
});
