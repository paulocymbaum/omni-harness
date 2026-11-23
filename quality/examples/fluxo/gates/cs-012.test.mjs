// Gate de entrega CS-012: a prévia nunca quebra por balão `data` sem dado da ficha.
// Worker: balão `data` sem fato casado vira `body`. Web: `data` sem fato degrada para `body` com aviso; só falha
// quando `factRefs` aponta para um id que não existe na ficha. O prompt diz que a cor vem do kit pela composição.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { read, stripComments } from './fc-gate-helper.mjs';

const WEB = 'ofluxo_site/src/platform';
const WORKER = 'services/creator-worker/src';

describe('Creator: prévia resiliente a balão data sem fato', () => {
  it('CS-012 worker: data sem fato casado vira body (nunca número inventado)', () => {
    const markdown = stripComments(read(`${WORKER}/llm/markdown.ts`));
    assert.match(markdown, /\{ \.\.\.balloon, factRefs: \[fact\.id\], data: factDataOf\(fact\) \} : \{ \.\.\.balloon, role: 'body' \}/);
    const unit = read(`${WORKER}/llm/markdown.test.ts`);
    assert.match(unit, /data sem fato vira body: lista com item da ficha e bullet sem número/);
  });

  it('CS-012 worker: o prompt diz que as cores do kit são aplicadas pela composição', () => {
    const slideCopy = stripComments(read(`${WORKER}/handlers/slide-copy.ts`));
    assert.match(slideCopy, /As cores do kit são aplicadas pela composição \(fundo, texto e destaque\)/);
    assert.match(slideCopy, /Não escreva cor no HTML; use <strong> para o que deve receber a cor de destaque/);
    assert.doesNotMatch(slideCopy, /sugestão, não obrigação/);
  });

  it('CS-012 web: data sem fato degrada para body com aviso; fact_not_found só com factRefs inexistente', () => {
    const editor = stripComments(read(`${WEB}/domain/creator-editor.ts`));
    assert.match(editor, /export type CreatorSpecWarning = 'data_without_fact';/);
    assert.match(editor, /if \(!ref\) return \{ ok: true, data: null \};/);
    assert.match(editor, /entry\.role = 'body';/);
    assert.match(editor, /warnings\.push\('data_without_fact'\)/);
    assert.match(editor, /return \{ ok: false, error: 'fact_not_found', factRef: resolved\.factRef \};/);

    const compose = stripComments(read(`${WEB}/presentation/pages/business/creator-compose.ts`));
    assert.match(compose, /Um item sem dado da ficha virou texto\./);
  });

  it('CS-012 testes: unidade cobre worker, spec da web e prévia', () => {
    const editorUnit = read(`${WEB}/domain/creator-editor.test.ts`);
    assert.match(editorUnit, /balão data sem fato resolvível vira body com aviso/);
    assert.match(editorUnit, /balão data com factRefs para fato inexistente é erro explícito/);
    const preview = read(`${WEB}/presentation/pages/business/business-creator-preview.test.tsx`);
    assert.match(preview, /balão data sem fato da ficha ainda mostra a prévia/);
  });
});
