// Gate de drift dos READMEs multilíngues: README.md (EN) é a REFERÊNCIA; cada tradução
// (README.pt-BR.md, README.es.md, README.zh-CN.md) deve ter a MESMA ESTRUTURA — mesmas
// contagens de seções ##, tabelas e blocos mermaid — e o banner com os 4 links de língua.
// Tradução não compara texto (línguas diferem), compara ESTRUTURA: se o EN ganhar/renomear
// seções sem espelhar, a contagem diverge e este gate reprova com a instrução de sync.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../lib/util.mjs';

const ROOT = repoRoot();
const EN = 'README.md';
const TRADUCOES = ['README.pt-BR.md', 'README.es.md', 'README.zh-CN.md'];
const TODOS = [EN, ...TRADUCOES];

const ler = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const secoes = (txt) => (txt.match(/^## .+$/gm) ?? []);
const tabelas = (txt) => (txt.match(/^\|---/gm) ?? []).length;
const mermaids = (txt) => (txt.match(/```mermaid/gm) ?? []).length;
const estrutura = (txt) => `${secoes(txt).length}##/${tabelas(txt)}tbl/${mermaids(txt)}mermaid`;

test('README.md (EN) existe e declara o banner das 4 línguas', () => {
  const txt = ler(EN);
  for (const rel of TODOS) assert.match(txt, new RegExp(`\\]\\(${rel.replace(/\./g, '\\.')}\\)`), `banner deve linkar ${rel}`);
});

test('todas as traduções existem e têm o mesmo banner de línguas', () => {
  for (const rel of TRADUCOES) {
    const txt = ler(rel);
    for (const outro of TODOS) assert.match(txt, new RegExp(`\\]\\(${outro.replace(/\./g, '\\.')}\\)`), `${rel}: banner deve linkar ${outro}`);
  }
});

test('estrutura das traduções == estrutura do EN (seções ##, tabelas, mermaid)', () => {
  const ref = estrutura(ler(EN));
  for (const rel of TRADUCOES) {
    assert.equal(estrutura(ler(rel)), ref, `${rel}: estrutura divergiu do README.md (EN) — o EN ganhou/perdeu seção, tabela ou mermaid sem espelhar a tradução`);
  }
});

test('drift detectável: seção a mais no EN muda a estrutura (tripwire viva)', () => {
  const ref = estrutura(ler(EN));
  const comSecaoExtra = `${ref.split('/')[0].replace(/^(\d+)/, (m) => String(Number(m) + 1))}/x`;
  assert.notEqual(comSecaoExtra, ref, 'uma seção ## extra DEVE mudar a assinatura de estrutura');
});
