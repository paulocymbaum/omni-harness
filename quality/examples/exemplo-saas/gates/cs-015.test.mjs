// Gate de entrega CS-015: o tamanho da imagem é FORÇADO pelo modelo do kit (uma escolha só: o passo 1,
// travado quando há modelo; o seletor do kit de marca sai) e a copy do worker SEMPRE cabe no layout —
// medida pelo motor real do render (copy-fit), com re-prompt por feedback e poda do último corpo no fim.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { read, stripComments } from './fc-gate-helper.mjs';

const BIZ = 'ofluxo_site/src/platform/presentation/pages/business';
const WORKER = 'services/creator-worker/src';

describe('Creator: tamanho forçado pelo modelo e copy que cabe na peça', () => {
  it('CS-015 worker: barreira copy-fit mede com o motor real, re-prompta e poda o último corpo', () => {
    const fit = stripComments(read(`${WORKER}/llm/copy-fit.ts`));
    assert.match(fit, /@fluxo\/creator-render\/node/);
    assert.match(fit, /createCopyFitCheckers/);
    assert.match(fit, /trimToFit/);
    assert.match(fit, /lastIndexOf\('body'\)/);

    const handler = stripComments(read(`${WORKER}/handlers/slide-copy.ts`));
    assert.match(handler, /fits\?/);
    assert.match(handler, /copy_does_not_fit \(o texto não cabe na peça/);
    assert.match(handler, /trimToFit/);
    assert.match(handler, /NO MÁXIMO 3 <li>/);

    const entrada = stripComments(read(`${WORKER}/index.ts`));
    assert.match(entrada, /createCopyFitCheckers\(\)/);
    assert.match(entrada, /fits: \(balloons, viewport\) => copyFits\(viewport\)\(balloons\)/);
  });

  it('CS-015 web: tamanho é forçado pelo modelo do kit e o seletor do kit sai', () => {
    const editor = stripComments(read(`${BIZ}/business-creator-editor.tsx`));
    assert.match(editor, /usePiecePreset/);
    assert.match(editor, /presetLocked/);
    assert.match(editor, /kit\.templates\[kit\.templates\.length - 1\]\?\.preset/);

    const view = stripComments(read(`${BIZ}/business-creator-view.tsx`));
    assert.match(view, /presetLocked: boolean/);
    assert.match(view, /locked=\{props\.presetLocked\}/);

    const steps = stripComments(read(`${BIZ}/business-creator-steps.tsx`));
    assert.match(steps, /O tamanho é detectado na arte do modelo do kit de marca\. Remova o modelo para escolher outro tamanho\./);
    assert.match(steps, /disabled=\{disabled \|\| locked\}/);

    const brand = stripComments(read(`${BIZ}/business-creator-brand.tsx`));
    assert.match(brand, /onTemplate: \(file: File\) => void/);
    assert.match(brand, /O tamanho é detectado na própria arte e o passo 1 passa a segui-lo/);
    assert.doesNotMatch(brand, /Tamanho de imagem deste modelo/);
    assert.doesNotMatch(brand, /onPreset/);

    const kitDominio = stripComments(read('ofluxo_site/src/platform/domain/creator-kit.ts'));
    assert.match(kitDominio, /closestPreset/);
    const efemero = stripComments(read('ofluxo_site/src/platform/infrastructure/creator-ephemeral.ts'));
    assert.match(efemero, /templateDimensions/);
    const kitHook = stripComments(read(`${BIZ}/use-creator-ephemeral-kit.ts`));
    assert.match(kitHook, /closestPreset\(width, height, presets\)/);
    assert.match(kitHook, /templateDimensions\(file\)/);
  });
});
