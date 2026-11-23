import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripLiterals } from '../lib/sanitize.mjs';

test('JS/TS: esvazia strings e regex com aspas, preserva comentários, código e linhas', () => {
  const src = "const re = /['\"]x/g;\nconst s = 'eslint-disable';\n// eslint-disable-next-line\nconst d = a / b / c;\n";
  const out = stripLiterals(src, 'typescript');
  assert.equal(out.split('\n').length, src.split('\n').length);
  assert.doesNotMatch(out.split('\n')[0], /['"]x/);
  assert.doesNotMatch(out.split('\n')[1], /eslint-disable/);
  assert.match(out.split('\n')[2], /\/\/ eslint-disable-next-line/);
  assert.match(out.split('\n')[3], /a \/ b \/ c/);
});

test('JS: URL dentro de string não vira comentário; template com ${} é esvaziado', () => {
  const out = stripLiterals("const u = 'http://x.com'; if (a) { b(); }\nconst t = `v=${x ? 1 : 2}`;\n", 'javascript');
  assert.match(out, /if \(a\) \{ b\(\); \}/);
  assert.doesNotMatch(out, /\?/);
});

test('Dart: strings simples, raw e triplas', () => {
  const src = "final a = r'\\d+\"';\nfinal b = '''\n// ignore: nada\n''';\n// ignore: avoid_print\nprint(a);\n";
  const out = stripLiterals(src, 'dart');
  assert.equal((out.match(/\/\/ ignore:/g) || []).length, 1);
  assert.match(out, /print\(a\);/);
});

test('Python e C#', () => {
  assert.equal((stripLiterals("x = '# noqa'\ny = 1  # noqa\n", 'python').match(/# noqa/g) || []).length, 1);
  assert.doesNotMatch(stripLiterals('var s = @"a ""#pragma warning disable"" b";\n', 'csharp'), /pragma/);
});

test('linguagem desconhecida: texto inalterado', () => {
  assert.equal(stripLiterals('a "b" c', 'yaml'), 'a "b" c');
});

test('TSX: tags de fechamento e self-closing não viram regex (chaves preservadas)', () => {
  const src = "function A({ e }) {\n  return (<div className={e.x}><X a={b} /></div>);\n}\nfunction B() { return 1; }\n";
  const out = stripLiterals(src, 'tsx');
  assert.equal((out.match(/[{}]/g) || []).length, (src.match(/[{}]/g) || []).length);
});
