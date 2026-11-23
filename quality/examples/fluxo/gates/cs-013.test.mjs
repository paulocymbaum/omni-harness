// Gate de entrega CS-013: o template do kit com o MESMO formato da peça vira o fundo da composição (prévia em
// HTML e PNG), pelo BackgroundInput `image` do pacote de render. Sem template no formato, fundo sólido.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { read, stripComments } from './fc-gate-helper.mjs';

const WEB = 'ofluxo_site/src/platform';
const BIZ = `${WEB}/presentation/pages/business`;

describe('Creator: template do formato como fundo da composição', () => {
  it('CS-013 kit: seleção do template pelo formato, sem fallback para outro formato', () => {
    const kit = stripComments(read(`${WEB}/domain/creator-kit.ts`));
    assert.match(kit, /export const templateForPreset = \(templates: readonly EphemeralTemplate\[\], preset: string\): EphemeralTemplate \| null =>/);
    assert.match(kit, /templates\.find\(\(template\) => template\.preset === preset\) \?\? null/);
  });

  it('CS-013 compose: o template entra como background image com foco central e nas chaves de cache', () => {
    const compose = stripComments(read(`${BIZ}/creator-compose.ts`));
    assert.match(compose, /template: EphemeralTemplate \| null;/);
    assert.match(compose, /async function backgroundOf\(template: EphemeralTemplate \| null\)/);
    assert.match(compose, /kind: 'image', image: \{ bytes, mime, width, height \}, focal: \{ x: 0\.5, y: 0\.5 \}/);
    assert.match(compose, /\.\.\.\(background \? \{ background \} : \{\}\)/);
    assert.match(compose, /const templateStampOf = /);
    assert.equal(compose.match(/templateStampOf\(input\.template\)/g)?.length, 2, 'chave da prévia e chave do cache incluem o template');
    assert.match(compose, /template: templateForPreset\(input\.kit\.templates, input\.viewport\.preset\)/);

    const view = stripComments(read(`${BIZ}/business-creator-view.tsx`));
    assert.match(view, /template: templateForPreset\(brand\.kit\.templates, props\.viewport\.preset\)/);
  });

  it('CS-013 testes: unidade cobre a seleção e as chaves', () => {
    assert.match(read(`${WEB}/domain/creator-kit.test.ts`), /sem template no formato escolhido não cai em outro formato/);
    const compose = read(`${BIZ}/creator-compose.test.ts`);
    assert.match(compose, /pieceInputKey muda quando o template entra, troca de arte ou de tamanho/);
    assert.match(compose, /pieceCacheKey não reaproveita o PNG de outra arte de template/);
  });
});
