// Gate QG-004-CI — as 4 camadas que não tinham CI nenhum (OCR, admin-web, ofluxo_site
// e services/debate-worker) passam a rodar lint, tipos e testes em todo PR, via
// .github/workflows/quality.yml. O gate também garante que os scripts que o workflow
// chama com --if-present EXISTEM de verdade (para nada ser pulado em silêncio).
// Rode: node --test quality/test/delivery/qg-004.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WF = path.join(ROOT, '.github', 'workflows', 'quality.yml');
// Exige o projeto hospedeiro real (.github/workflows): ausente no exemplo → skip com motivo.
const SKIP_SEM_PROJETO = fs.existsSync(path.join(ROOT, '.github', 'workflows')) ? {} : { skip: 'exige .github/workflows do projeto hospedeiro (ausente no exemplo)' };

function read(file) {
  const p = path.join(ROOT, file);
  assert(fs.existsSync(p), `${file} não encontrado`);
  return fs.readFileSync(p, 'utf8');
}

function readScripts(pkgRel) {
  const pkg = JSON.parse(read(path.join(pkgRel, 'package.json')));
  return pkg.scripts ?? {};
}

test('qg-004: workflow de qualidade existe e é o veículo das camadas órfãs', SKIP_SEM_PROJETO, () => {
  const yml = read('.github/workflows/quality.yml');
  assert.match(yml, /OCR_webscraper_crawler\/\*\*/, 'paths-filter da camada OCR ausente');
  for (const dir of ['admin-web/**', 'ofluxo_site/**', 'services/debate-worker/**']) {
    assert.ok(yml.includes(dir), `paths-filter de ${dir} ausente`);
  }
});

test('qg-004: job OCR roda typecheck e testes', SKIP_SEM_PROJETO, () => {
  const yml = read('.github/workflows/quality.yml');
  const ocrIdx = yml.indexOf('\n  ocr:');
  assert.ok(ocrIdx >= 0, 'job ocr ausente');
  const ocr = yml.slice(ocrIdx);
  assert.match(ocr, /pnpm --dir OCR_webscraper_crawler typecheck/, 'typecheck do OCR ausente no CI');
  assert.match(ocr, /pnpm --dir OCR_webscraper_crawler test/, 'testes do OCR ausentes no CI');
});

test('qg-004: job web cobre admin-web, ofluxo_site e debate-worker com lint, tipos e testes', SKIP_SEM_PROJETO, () => {
  const yml = read('.github/workflows/quality.yml');
  const webIdx = yml.indexOf('\n  web:');
  const gateIdx = yml.indexOf('\n  gate:');
  assert.ok(webIdx >= 0 && gateIdx > webIdx, 'job web ausente');
  const web = yml.slice(webIdx, gateIdx);
  for (const projeto of ['admin-web', 'ofluxo_site', 'services/debate-worker']) {
    assert.ok(web.includes(projeto), `matrix do job web não inclui ${projeto}`);
  }
  for (const passo of ['npm run lint --if-present', 'npm run typecheck --if-present', 'npm test --if-present']) {
    assert.ok(web.includes(passo), `passo "${passo}" ausente no job web`);
  }
});

test('qg-004: os scripts chamados com --if-present existem em cada projeto (nada é pulado)', SKIP_SEM_PROJETO, () => {
  for (const projeto of ['admin-web', 'ofluxo_site', 'services/debate-worker']) {
    const scripts = readScripts(projeto);
    assert.ok(scripts.lint, `${projeto}: script lint ausente`);
    assert.ok(scripts.test, `${projeto}: script test ausente`);
  }
  assert.ok(readScripts('ofluxo_site').typecheck, 'ofluxo_site: script typecheck ausente');
  assert.ok(readScripts('services/debate-worker').typecheck, 'services/debate-worker: script typecheck ausente');

  const ocrPkg = read('OCR_webscraper_crawler/package.json');
  assert.ok(ocrPkg.includes('"typecheck"'), 'OCR: script typecheck ausente no package.json raiz');
  assert.ok(ocrPkg.includes('"test"'), 'OCR: script test ausente no package.json raiz');
});

test('qg-004: o consolidador gate depende de ocr e web', SKIP_SEM_PROJETO, () => {
  const yml = read('.github/workflows/quality.yml');
  assert.match(yml, /needs: \[higiene, flutter, ocr, web\]/, 'gate precisa depender de ocr e web');
});
