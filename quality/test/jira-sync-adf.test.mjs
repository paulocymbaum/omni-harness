// Gates da integração Jira — conversor markdown→ADF e limites da API v3.
// Garante que descrições/comentários não são truncados silenciosamente:
// spec integral entra no card; acima de 32.767 chars há aviso explícito.
// Rodar: node --test quality/test/jira-sync-adf.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { markdownToAdf } from '../../scripts/tracker/sync-context.mjs';
import { textToDoc, adfTextLength, JIRA_MAX_FIELD_CHARS } from '../../scripts/tracker/jira-client.mjs';

function docText(doc) {
  let out = '';
  for (const block of doc.content ?? []) {
    for (const node of block.content ?? []) {
      if (typeof node.text === 'string') out += `${node.text}\n`;
    }
  }
  return out;
}

test('títulos, listas e checkboxes viram ADF estruturado', () => {
  const doc = markdownToAdf([
    '# Título',
    '',
    '- `GATE-X` [command] — `node --test x.test.mjs`',
    '- [ ] critério pendente',
    '- [x] critério feito',
    '',
    '1. primeiro',
    '2. segundo',
  ].join('\n'));
  assert.equal(doc.content[0].type, 'heading');
  assert.equal(doc.content[0].attrs.level, 1);
  assert.equal(doc.content[1].type, 'bulletList');
  const items = doc.content[1].content.map((li) => li.content[0].content[0].text);
  assert.ok(items[0].includes('GATE-X'));
  assert.ok(items[1].startsWith('☐ critério pendente'));
  assert.ok(items[2].startsWith('☑ critério feito'));
  assert.equal(doc.content[2].type, 'orderedList');
});

test('fence de código vira codeBlock e linha simples vira parágrafo', () => {
  const doc = markdownToAdf('```text\nlinha 1\nlinha 2\n```\n\nparágrafo final');
  assert.equal(doc.content[0].type, 'codeBlock');
  assert.equal(doc.content[0].content[0].text, 'linha 1\nlinha 2');
  assert.equal(doc.content[1].type, 'paragraph');
  assert.equal(doc.content[1].content[0].text, 'parágrafo final');
});

test('parágrafo multilinha preserva quebras com hardBreak (não colapsa)', () => {
  const doc = textToDoc('linha A\nlinha B\n\nlinha C');
  assert.equal(doc.content.length, 2, 'linha vazia separa parágrafos');
  const first = doc.content[0].content;
  assert.equal(first[0].text, 'linha A');
  assert.equal(first[1].type, 'hardBreak', 'quebra explícita dentro do parágrafo');
  assert.equal(first[2].text, 'linha B');
});

test('spec acima do limite é truncada COM aviso e referência à tarefa', () => {
  const big = 'x'.repeat(JIRA_MAX_FIELD_CHARS + 5000);
  const doc = markdownToAdf(`# Spec\n\n${big}`, { id: 'MAN-001' });
  const total = adfTextLength(doc);
  assert.ok(total <= JIRA_MAX_FIELD_CHARS, `deve caber no limite da API (${total})`);
  const text = docText(doc);
  assert.ok(text.includes('⚠️ Descrição truncada'), 'aviso de truncamento presente');
  assert.ok(text.includes('MAN-001'), 'aviso referencia a spec integral da tarefa');
});

test('spec abaixo do limite entra integral, sem corte silencioso', () => {
  const body = Array.from({ length: 400 }, (_, i) => `linha detalhada ${i} com conteúdo real da spec`).join('\n');
  const doc = markdownToAdf(`# Spec MAN-999\n\n${body}`, { id: 'MAN-999' });
  const text = docText(doc);
  assert.ok(text.includes('linha detalhada 0 '));
  assert.ok(text.includes('linha detalhada 399'), 'última linha da spec presente — sem slice de 800');
  assert.ok(!text.includes('⚠️ Descrição truncada'), 'não deve truncar conteúdo curto');
});
