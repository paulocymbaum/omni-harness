// Gates FC-003 — pacote @fluxo/creator-render (Satori + resvg): balões React, layout, contraste WCAG, segurança de imagem e golden.
// ANTES da implementação cada gate DEVE falhar.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-11-14-fluxo-creator FC-003 --baseline
// Tudo roda no host com node e npm, sem Docker. O Vitest roda DENTRO de packages/creator-render (templates em quality/test/delivery/fc-render/,
// copiados só durante o gate), faz `npm ci` se faltar node_modules e FALHA, não pula. Nenhum gate toca em services/debate-worker.
//
// Contrato de ligação fixado pelos gates (a spec dá nomes, não todas as formas; ver os cabeçalhos dos templates):
//   src/index.ts exporta contrastRatio, classifyContrast, adjustForegroundLightness, resolvePalette ({ pairA, pairB, accent }), paletteReport,
//   CONTRAST_GOOD/WARN, computeLayout, createSatoriMeasurer, createSvgRenderer, validateRenderSpec, RenderSpecError, RENDER_HARD_LIMITS,
//   DEFAULT_LAYOUT_POLICY, CSS_ALLOWLIST e os 5 componentes; src/node.ts exporta createNodeRenderer e loadBundledFonts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT, assertEnumsEverywhere, ensurePackageInstalled, exists, read, runPackageVitest, stripComments, walk } from './fc-gate-helper.mjs';

const PKG = 'packages/creator-render';
const SRC = `${PKG}/src`;
const files = (names, only, minimum) => runPackageVitest(PKG, 'fc-render',
  Object.fromEntries(['gate-fc003-support.ts', ...names].map((f) => [f, `test/${f}`])), minimum, { only });
const sources = () => walk(SRC, (f) => /\.tsx?$/.test(f));
const sha = (rel) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');

function npm(...args) {
  const r = spawnSync('npm', args, { cwd: path.join(ROOT, PKG), encoding: 'utf8', timeout: 100_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(r.error, undefined, `npm ${args.join(' ')} não executou: ${r.error?.message}`);
  assert.equal(r.status, 0, `npm ${args.join(' ')} falhou:\n${`${r.stdout}\n${r.stderr}`.split('\n').slice(-30).join('\n')}`);
}

function ensureBuilt() {
  ensurePackageInstalled(PKG);
  npm('run', 'build');
  assert.ok(exists(`${PKG}/dist/index.js`) && exists(`${PKG}/dist/node.js`), 'build não gerou dist/index.js e dist/node.js');
}

/** Fecho de imports relativos a partir de uma entrada, devolvendo o que cada arquivo importa. */
function closure(entry) {
  const seen = new Map();
  const visit = (file) => {
    if (seen.has(file)) return;
    const code = stripComments(read(file));
    const specs = [...code.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    seen.set(file, specs);
    for (const spec of specs.filter((s) => s.startsWith('.'))) {
      const base = path.posix.join(path.posix.dirname(file), spec).replace(/\.js$/, '');
      const next = ['.ts', '.tsx', '/index.ts'].map((ext) => base + ext).find(exists);
      if (next) visit(next);
    }
  };
  visit(entry);
  return seen;
}

test('FC-003 pacote: package.json, exports seguros, peers, lockfile, build e fronteiras de camada', () => {
  assert.ok(exists(`${PKG}/package.json`), 'packages/creator-render/package.json ausente');
  const pkg = JSON.parse(read(`${PKG}/package.json`));
  assert.equal(pkg.name, '@fluxo/creator-render');
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.version, '0.1.0');
  assert.match(pkg.engines?.node ?? '', /22/);
  for (const key of ['.', './node']) {
    const entry = pkg.exports?.[key];
    assert.ok(entry, `exports sem ${key}`);
    const flat = JSON.stringify(entry);
    assert.match(flat, /dist\//, `${key} deve apontar para dist/`);
    assert.match(flat, /"types"/, `${key} sem types`);
  }
  assert.ok(pkg.exports?.['./assets/*'], 'exports sem ./assets/*');
  assert.equal(pkg.peerDependencies?.react, '^19');
  assert.match(pkg.peerDependencies?.satori ?? '', /^\^0\.63/);
  assert.match(pkg.peerDependencies?.['@resvg/resvg-js'] ?? '', /^\^2\.6/);
  assert.equal(pkg.peerDependenciesMeta?.['@resvg/resvg-js']?.optional, true, '@resvg/resvg-js deve ser peer opcional');
  for (const dep of ['react', 'satori', '@resvg/resvg-js', 'vitest', 'typescript', 'eslint', 'typescript-eslint', '@eslint/js', 'globals', '@types/react', '@types/node', 'pixelmatch', 'pngjs'])
    assert.ok(pkg.devDependencies?.[dep], `devDependencies sem ${dep}`);
  assert.ok(!pkg.dependencies?.zod && !pkg.peerDependencies?.zod && !pkg.devDependencies?.zod, 'sem zod: a validação de entrada é manual');
  for (const forbidden of ['sharp']) assert.ok(!pkg.dependencies?.[forbidden] && !pkg.peerDependencies?.[forbidden], `${forbidden} fica fora do pacote`);
  for (const script of ['build', 'typecheck', 'lint', 'test', 'test:golden', 'golden:update']) assert.ok(pkg.scripts?.[script], `script ${script} ausente`);
  assert.match(pkg.scripts['golden:update'], /UPDATE_GOLDEN=1/);
  assert.ok(exists(`${PKG}/package-lock.json`), 'package-lock.json ausente (npm, decisão 1)');
  assert.ok(!exists('pnpm-workspace.yaml'), 'não criar workspace na raiz');
  assert.ok(!JSON.parse(read('package.json')).workspaces, 'package.json raiz não pode declarar workspaces');
  for (const entry of ['src/index.ts', 'src/node.ts', 'src/domain/creator-enums.ts']) assert.ok(exists(`${PKG}/${entry}`), `${entry} ausente`);
  const browserSafe = closure(`${SRC}/index.ts`);
  const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
  const unsafe = [...browserSafe].flatMap(([file, specs]) => specs.filter((s) => s.startsWith('node:') || builtins.has(s) || s === 'sharp' || s.startsWith('@resvg/')).map((s) => `${file}: ${s}`));
  assert.deepEqual(unsafe, [], 'o fecho de src/index.ts toca módulo só de Node (a entrada "." precisa abrir no navegador)');
  const crossing = sources().flatMap((file) => [...stripComments(read(file)).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
    .filter((s) => /ofluxo_site|services\/|\/lib\/|functions\/|\.\.\/\.\.\/\.\./.test(s)).map((s) => `${file}: ${s}`));
  assert.deepEqual(crossing, [], 'o pacote não importa de ofluxo_site, services, lib nem functions');
  const hooks = walk(`${SRC}/components`, (f) => /\.tsx?$/.test(f)).filter((f) => /\buse(State|Effect|Memo|Callback|Ref|Context|Reducer|LayoutEffect|Id|Transition|DeferredValue|SyncExternalStore)\b/.test(stripComments(read(f))));
  assert.deepEqual(hooks, [], 'hook React em componente (o Satori não suporta)');
  assert.ok(walk(`${SRC}/components`, (f) => f.endsWith('.tsx')).length >= 5, 'faltam os 5 componentes (.tsx)');
  ensureBuilt();
  for (const out of ['dist/index.d.ts', 'dist/node.d.ts']) assert.ok(exists(`${PKG}/${out}`), `${out} ausente (types)`);
});

test('FC-003 tipos-lint: typecheck e lint saem com 0', () => {
  ensurePackageInstalled(PKG);
  npm('run', 'typecheck');
  npm('run', 'lint');
});

test('FC-003 contraste: razão WCAG, limiares 4,5 e 3, ajuste só de luminosidade, idempotente e determinístico', () => {
  files(['gate-fc003-contrast.test.ts'], 'FC-003 contraste', 8);
});

test('FC-003 paleta-papeis: 2, 3, 4 e 5 cores batem com a tabela, 1 e 6 lançam palette_size e o relatório traz razão e nível', () => {
  files(['gate-fc003-contrast.test.ts'], 'FC-003 paleta-papeis', 6);
});

test('FC-003 layout: 6 viewports com medidor falso e Satori real, mínimo legível nunca violado, text_too_long, no_free_area e determinismo', () => {
  files(['gate-fc003-layout.test.ts'], 'FC-003 layout', 12);
});

test('FC-003 componentes: render estrito sem erro de estilo, só CSS da allowlist, só famílias registradas, título em Exemplo SaaS Sans 400', () => {
  files(['gate-fc003-components.test.ts'], 'FC-003 componentes', 6);
});

test('FC-003 seguranca-imagem: WebP, GIF, bytes inválidos, mime mentiroso, SVG ativo, URL remota e lado acima de 4096 recusados', () => {
  files(['gate-fc003-images.test.ts'], 'FC-003 seguranca-imagem', 6);
});

test('FC-003 validacao: códigos estáveis de RenderSpecError e font_missing sem fallback silencioso', () => {
  files(['gate-fc003-images.test.ts'], 'FC-003 validacao', 6);
});

test('FC-003 render-determinismo: mesmos bytes em duas execuções e em processos distintos, PNG com o tamanho do viewport, resvg sem fontes do sistema', () => {
  ensureBuilt();
  files(['gate-fc003-render.test.ts'], 'FC-003 render-determinismo', 4);
});

test('FC-003 golden: 8 casos do manifest, SVG exato e PNG de 540 px com tolerância, golden ausente reprova, UPDATE_GOLDEN fora do gate', () => {
  assert.equal(process.env.UPDATE_GOLDEN, undefined, 'o gate nunca define UPDATE_GOLDEN');
  for (const name of ['feed_square_titulo_corpo', 'feed_portrait_dado', 'story_marcas', 'landscape', 'contraste_corrigido', 'fundo_imagem_focal', 'paleta_3_cores', 'custom_320']) {
    assert.ok(exists(`${PKG}/test/golden/${name}.svg`) && exists(`${PKG}/test/golden/${name}.png`), `golden ausente: ${name}`);
  }
  assert.ok(exists(`${PKG}/test/golden/manifest.json`), 'manifest.json ausente');
  files(['gate-fc003-render.test.ts'], 'FC-003 golden', 4);
});

test('FC-003 paridade-svg: satori/standalone com layout.wasm gera o mesmo SVG que satori em todos os casos golden', () => {
  assert.ok(exists(`${PKG}/test/golden/manifest.json`), 'manifest.json ausente');
  files(['gate-fc003-render.test.ts'], 'FC-003 paridade-svg', 1);
});

test('FC-003 enums-espelho: 3 enums do pacote iguais ao C# e ao site, registrados em CANONICAL_ENUMS, sem redefinição', async () => {
  const mirror = `${SRC}/domain/creator-enums.ts`;
  await assertEnumsEverywhere({
    CreatorViewportPreset: ['feed_square', 'feed_portrait', 'story', 'landscape'],
    WatermarkCorner: ['top_left', 'top_right', 'bottom_left', 'bottom_right'],
    SlideRole: ['hook', 'context', 'data', 'body', 'cta'],
  }, { tsFile: mirror });
  const { CANONICAL_ENUMS } = await import(pathToFileURL(path.join(ROOT, '.claude/hooks/lib/regras.mjs')).href);
  for (const name of ['CreatorViewportPreset', 'WatermarkCorner', 'SlideRole']) {
    assert.ok(CANONICAL_ENUMS[name].includes('ofluxo_site/src/platform/domain/creator-enums.ts'), `${name} sem o espelho do site`);
    assert.ok(CANONICAL_ENUMS[name].includes('backend/src/Exemplo SaaS.Api/Modules/Creator/Domain/CreatorEnums.cs'), `${name} sem a fonte C#`);
  }
  const mirrorCode = read(mirror);
  assert.doesNotMatch(mirrorCode, /from ['"]zod['"]/, 'o espelho do pacote não usa zod');
  assert.match(mirrorCode, /as const/);
  const redefinitions = sources().filter((f) => f !== mirror).filter((f) => /\b(?:enum|class|type|interface|const)\s+(?:CreatorViewportPreset|WatermarkCorner|SlideRole)\b/.test(read(f)));
  assert.deepEqual(redefinitions, [], 'enum do Creator redefinida fora de creator-enums.ts');
  assert.ok(!/\bSlideRole\b/.test(stripComments(sources().filter((f) => /components\//.test(f)).map(read).join('\n'))), 'BalloonRole não pode reutilizar o nome SlideRole nos componentes');
});

test('FC-003 assets-deriva: fontes e logotipo do pacote têm o mesmo sha256 das fontes do repositório e do kit de marca', () => {
  for (const font of ['Exemplo SaaSSans-Regular.ttf', 'Archivo-Regular.ttf', 'Archivo-Bold.ttf']) {
    assert.ok(exists(`${PKG}/assets/fonts/${font}`), `fonte ausente no pacote: ${font}`);
    assert.equal(sha(`${PKG}/assets/fonts/${font}`), sha(`assets/fonts/${font}`), `${font} diverge de assets/fonts/`);
  }
  assert.ok(exists(`${PKG}/assets/fonts/OFL-Archivo.txt`), 'licença OFL-Archivo.txt ausente');
  assert.equal(sha(`${PKG}/assets/fonts/OFL-Archivo.txt`), sha('assets/fonts/OFL-Archivo.txt'));
  for (const logo of ['logotipo-branco.svg', 'logotipo-cor.svg']) {
    assert.ok(exists(`${PKG}/assets/brand/${logo}`), `logotipo ausente: ${logo}`);
    assert.equal(sha(`${PKG}/assets/brand/${logo}`), sha(`fluxo_branding_book/fluxo-kit/01-logos/svg/${logo}`), `${logo} diverge do kit de marca`);
  }
});

test('FC-003 desempenho: 10 renders de 1080x1350 abaixo de 3000 ms e um 4096x4096 conclui, com os números impressos', () => {
  ensureBuilt();
  files(['gate-fc003-render.test.ts'], 'FC-003 desempenho', 1);
});

test('FC-003 privacidade: sem CPF/CNPJ, sem rede e sem fetch no pacote', () => {
  const code = sources();
  assert.ok(code.length > 0, 'código do pacote ausente');
  const offenders = [];
  for (const file of code) {
    const text = stripComments(read(file));
    if (/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b|\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b|\b\d{11}\b|\b\d{14}\b/.test(text)) offenders.push(`${file}: CPF/CNPJ literal`);
    if (/\b(cpf|cnpj)\b/i.test(text)) offenders.push(`${file}: campo cpf/cnpj`);
    if (/\bfetch\s*\(|from\s+['"](?:node:)?(?:https?|net|tls|dgram|dns)['"]|\bXMLHttpRequest\b|\bWebSocket\b/.test(text)) offenders.push(`${file}: acesso à rede`);
  }
  assert.deepEqual(offenders, []);
});

test('FC-003 camada: pacote registrado em quality/config/layers.json e no webRoutine do runner de TypeScript', () => {
  const layers = JSON.parse(read('quality/config/layers.json')).layers;
  const index = layers.findIndex((l) => l.id === 'creator-render');
  assert.ok(index >= 0, 'layers.json sem a camada creator-render');
  assert.deepEqual(layers[index].globs, [`${PKG}/**`]);
  assert.equal(layers[index].doc, `${PKG}/README.md`);
  assert.ok(index < layers.findIndex((l) => l.id === 'docs'), 'a camada precisa vir antes de docs (a primeira que casa vence)');
  const runner = read('quality/lib/runners/typescript.mjs');
  const loop = runner.match(/for \(const app of \[([^\]]*)\]\)/);
  assert.ok(loop, 'webRoutine sem a lista de apps');
  assert.ok(loop[1].includes(`'${PKG}'`), `webRoutine não inclui '${PKG}'`);
});

test('FC-003 docs: README do pacote, ponteiro no desenho e linha na skill ui-fluxo', () => {
  const readme = read(`${PKG}/README.md`);
  for (const piece of ['file:', 'npm --prefix packages/creator-render run build', 'WebP', 'UPDATE_GOLDEN', 'CSS_ALLOWLIST', 'resolve.dedupe', 'golden']) assert.ok(readme.includes(piece), `README do pacote sem "${piece}"`);
  assert.match(read('docs/parking-lot/fluxo-creator.md'), /FC-003/, 'desenho sem o ponteiro "pacote implementado em FC-003"');
  assert.match(read('.claude/skills/ui-fluxo/SKILL.md'), /packages\/creator-render/, 'skill ui-fluxo sem a linha apontando packages/creator-render');
});
