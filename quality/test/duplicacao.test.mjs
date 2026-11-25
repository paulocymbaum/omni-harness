// Gate de duplicação estrutural: fixtures sintéticas para a lib (sem lizard) + integração
// com o lizard real quando disponível (sem ele, degrada para [] — comportamento contratado).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analisaLote, prepara, normaliza, hashDe, tiposDe, corpoDe } from '../lib/clones.mjs';
import { duplicacaoGateLote, julgaLote } from '../lib/gates/duplicacao.mjs';
import { lizardCommand } from '../lib/tools.mjs';
import { entry } from './helpers.mjs';

const CFG = { corpoMinNloc: 6, tipoMinLinhas: 10, nomeMinArquivos: 3, jaccardMinimo: 0.85, tokensMinimos: 12, maxGrupo: 8 };
const kinds = (r) => r.achados.map((a) => a.kind);

const fn = (name, start, end) => ({ name, longName: name, start, end, nloc: end - start + 1 });
const arquivo = (path, texto, funcoes = []) => ({
  path,
  lang: path.endsWith('.py') ? 'python' : path.endsWith('.go') ? 'go' : 'javascript',
  texto,
  funcoes,
});

const CORPO_A = [
  'function runGate(classes) {',
  '  const names = Object.keys(classes);',
  "  const dir = criarDiretorio('trx');",
  '  const filtros = names.map((c) => montarFiltro(c));',
  '  const resultados = rodarTestes(filtros, dir);',
  '  const falhas = resultados.filter((r) => r.falhou);',
  "  comparar(falhas, [], 'testes falharam');",
  '  return resultados;',
  '}',
].join('\n');
const CORPO_B = CORPO_A.replace('montarFiltro', 'montarSelecao');
const CORPO_C = CORPO_A.replace('rodarTestes', 'rodarSuite');

test('clone exato: mesmo corpo em dois arquivos → 1 achado kind clone', () => {
  const a1 = arquivo('pkg/a.mjs', CORPO_A, [fn('runGate', 1, 9)]);
  const textoB = ['// pacote b', '', 'const x = 1;', '', CORPO_A].join('\n');
  const a2 = arquivo('pkg/b.mjs', textoB, [fn('runGate', 5, 13)]);
  const r = analisaLote([a1, a2], CFG);
  assert.deepEqual(kinds(r), ['clone']);
  assert.equal(r.achados[0].origem.arquivo, 'pkg/a.mjs');
  assert.equal(r.achados[0].destino.arquivo, 'pkg/b.mjs');
  assert.equal(r.achados[0].destino.linha, 5);
});

test('corpo trivial (nloc < mínimo) não é clone; normaliza ignora comentário/literal/número/espaço', () => {
  const pequeno = 'const f = (x) => {\n  return x + 1;\n};';
  const r = analisaLote([arquivo('pkg/a.mjs', pequeno, [fn('f', 1, 3)]), arquivo('pkg/b.mjs', pequeno, [fn('f', 1, 3)])], CFG);
  assert.deepEqual(r.achados, []);
  const t1 = prepara('function f() { return 1; } // nota', 'javascript');
  const t2 = prepara('function f() {\n  return 2;\n}', 'javascript');
  assert.equal(hashDe(normaliza(t1)), hashDe(normaliza(t2)));
  assert.equal(prepara('a\nbb', 'x').split('\n').length, 2);
});

test('quase-clone: corpo que derivou no mesmo longName → kind quase com similaridade', () => {
  const r = analisaLote([arquivo('pkg/a.mjs', CORPO_A, [fn('runGate', 1, 9)]), arquivo('pkg/b.mjs', CORPO_B, [fn('runGate', 1, 9)])], CFG);
  assert.deepEqual(kinds(r), ['quase']);
  assert.ok(r.achados[0].valor >= 0.85);
  assert.ok(r.achados[0].valor < 1);
});

test('nome repetido: mesmo longName em 3 arquivos com corpos diferentes → kind nome; main é ignorado', () => {
  const lotes = ['pkg/a.mjs', 'pkg/b.mjs', 'pkg/c.mjs'].map((p, i) => arquivo(p, [CORPO_A, CORPO_B, CORPO_C][i], [fn('runGate', 1, 9)]));
  const r = analisaLote(lotes, CFG);
  assert.ok(kinds(r).includes('nome'));
  const nome = r.achados.find((a) => a.kind === 'nome');
  assert.equal(nome.contagem, 3);
  const mains = ['x/a.mjs', 'x/b.mjs', 'x/c.mjs'].map((p, i) => arquivo(p, [CORPO_A, CORPO_B, CORPO_C][i], [fn('main', 1, 9)]));
  assert.ok(!kinds(analisaLote(mains, CFG)).includes('nome'));
});

test('quase-clone exige parecença: corpos divergentes no mesmo nome não viram achado', () => {
  const divergente = [
    'function runGate(cfg) {',
    '  const total = cfg.itens.reduce((s, i) => s + i.valor, 0);',
    '  if (total > cfg.teto) return null;',
    "  gravar('nota', total);",
    '  const media = total / cfg.itens.length;',
    '  publicar({ total, media });',
    '  return { total, media };',
    '}',
  ].join('\n');
  const r = analisaLote([arquivo('pkg/a.mjs', CORPO_A, [fn('runGate', 1, 9)]), arquivo('pkg/b.mjs', divergente, [fn('runGate', 1, 8)])], CFG);
  assert.deepEqual(r.achados, []);
});

const CLASSE_A = [
  'export class ServicoPagamento {',
  '  constructor(repo, relogio) {',
  '    this.repo = repo;',
  '    this.relogio = relogio;',
  '  }',
  '  cobrar(pedido) {',
  '    const hoje = this.relogio.hoje();',
  '    if (pedido.vencido(hoje)) return null;',
  '    return this.repo.salvar({ pedido, hoje });',
  '  }',
  '}',
].join('\n');
const CLASSE_B = CLASSE_A.replace('cobrar', 'debitar');

test('tipo idêntico em dois arquivos → kind tipo; mesmo nome com corpo diferente → nada', () => {
  const lotes = [arquivo('pkg/a.ts', CLASSE_A, []), arquivo('pkg/b.ts', CLASSE_A, [])];
  assert.deepEqual(kinds(analisaLote(lotes, CFG)), ['tipo']);
  const divergentes = [arquivo('pkg/a.ts', CLASSE_A, []), arquivo('pkg/b.ts', CLASSE_B, [])];
  assert.deepEqual(analisaLote(divergentes, CFG).achados, []);
});

test('tiposDe: extração por chaves (go struct) e por indentação (python class)', () => {
  const go = 'type Repositorio struct {\n  nome string\n  tamanho int\n}\n\nfunc (r *Repositorio) salvar() {}\n';
  const tgo = tiposDe(prepara(go, 'go'), 'go');
  assert.equal(tgo[0].nome, 'Repositorio');
  assert.equal(corpoDe(go, { start: 1, end: 4 }).startsWith('type'), true);
  const py = 'class Cliente:\n    def __init__(self, nome):\n        self.nome = nome\n\n    ativo = True\n\nfim = 1\n';
  const tpy = tiposDe(prepara(py, 'python'), 'python');
  assert.equal(tpy[0].nome, 'Cliente');
  assert.ok(tpy[0].corpo.includes('self.nome'));
  assert.ok(!tpy[0].corpo.includes('fim = 1'));
});

test('integração: lizard real no lote — cópia → fail; limpo → pass; reuso do Map não mede de novo', () => {
  const textoA = `export function rodaLote(itens) {\n  const prontos = itens.filter((i) => i.pronto);\n  const nomes = prontos.map((i) => i.nome);\n  ordenar(nomes);\n  gravar(nomes);\n  return nomes.length;\n}\n`;
  const textoB = [
    'export function somaTotal(itens) {',
    '  let total = 0;',
    '  for (const item of itens) {',
    '    total += item.valor;',
    '  }',
    '  return total;',
    '}',
  ].join('\n');
  if (!lizardCommand()) {
    assert.deepEqual(duplicacaoGateLote([entry('pkg/a.mjs', null, textoA)], null), []);
    return;
  }
  const copia = duplicacaoGateLote([entry('pkg/a.mjs', null, textoA), entry('pkg/b.mjs', null, textoA)], null);
  assert.equal(copia[0].status, 'fail');
  assert.equal(copia[0].key, 'duplicacao.cloneCorpo');
  const limpo = duplicacaoGateLote([entry('pkg/a.mjs', null, textoA), entry('pkg/b.mjs', null, textoB)], null);
  assert.equal(limpo[0].status, 'pass');
  assert.equal(limpo[0].key, 'duplicacao.pass');
  const direto = julgaLote([entry('pkg/a.mjs', null, textoA)], new Map([['pkg/a.mjs', [{ name: 'rodaLote', longName: 'rodaLote', start: 1, end: 7, nloc: 7 }]]]));
  assert.equal(direto[0].status, 'pass');
});
