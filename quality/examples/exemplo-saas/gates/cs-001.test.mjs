// Gate de entrega CS — Creator pós-epico: selo do dado no PNG (RN-14), prévia antes do render e usabilidade.
// Estático de propósito: lê as três camadas (worker, backend, web) e os testes de unidade que provam o contrato.
// Sem banco, rede, npm ci ou render real — a prova ponta a ponta é a homologação (CS-005).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { exists, read, stripComments } from './fc-gate-helper.mjs';

const WORKER = 'services/creator-worker/src';
const BACKEND = 'backend/src/Exemplo SaaS.Api/Modules/Creator';
const WEB = 'ofluxo_site/src/platform';
const DELIVERY = 'docs/entregas/2026-11-17-creator-selo-ux';

describe('Creator: selo do dado e prévia antes do PNG', () => {
  it('CS-001 worker: o balão data sai com o selo da ficha (valor, rótulo, fonte e ano)', () => {
    const markdown = stripComments(read(`${WORKER}/llm/markdown.ts`));
    assert.match(markdown, /export function withFactData\(balloons: CopyBalloon\[\], facts: readonly CreatorFact\[\]\): CopyBalloon\[\]/);
    assert.match(markdown, /const factDataOf = \(fact: CreatorFact\): CopyBalloonData => \(\{/);
    assert.match(markdown, /value: fact\.display/);
    assert.match(markdown, /label: fact\.label/);
    assert.match(markdown, /source: fact\.source\.org/);
    assert.match(markdown, /year: fact\.period/);
    assert.match(markdown, /if \(balloon\.role !== 'data'\) return balloon/);

    const validate = stripComments(read(`${WORKER}/llm/validate-copy.ts`));
    assert.match(validate, /export type CopyBalloonData = \{ value: string;/);
    assert.match(validate, /data\?: CopyBalloonData/);
    assert.match(validate, /export const sameNumber = \(allowed: number, cited: number\): boolean =>/);

    const slideCopy = stripComments(read(`${WORKER}/handlers/slide-copy.ts`));
    assert.match(slideCopy, /withFactData\(blocksToBalloons\(blocks, limits\), facts\)/);

    const unit = read(`${WORKER}/llm/markdown.test.ts`);
    assert.match(unit, /describe\('dado da ficha no balão data'/);
    assert.match(unit, /só o balão data recebe o selo/);
    assert.match(unit, /número fora da ficha vira texto body, sem data/);
  });

  it('CS-001 backend: grava e repassa o data em todo caminho de render', () => {
    const spec = stripComments(read(`${BACKEND}/Application/CreatorRenderSpec.cs`));
    assert.match(spec, /public static Dictionary<string, object\?> StoredBalloon\(string role, string text, JsonElement source\)/);
    assert.match(spec, /private static readonly string\[\] BalloonDataFields = \["value", "unit", "label", "source", "year"\]/);
    assert.match(spec, /if \(data\.ContainsKey\("value"\)\) balloon\["data"\] = data/);
    assert.match(spec, /balloon\["data"\] = data\.Clone\(\)/);

    const endpoints = stripComments(read(`${BACKEND}/CreatorProjectEndpoints.cs`));
    assert.match(endpoints, /CreatorRenderSpec\.StoredBalloon\(role, text, balloon\)/);

    const service = stripComments(read(`${BACKEND}/Application/CreatorProjectService.cs`));
    assert.match(service, /CreatorRenderSpec\.BalloonsOf\(body, project\.Copy\)/);
    assert.match(service, /CreatorRenderSpec\.ParseSlides\(slidesEl, options\.Value\)/);

    const tests = read('backend/tests/Exemplo SaaS.Api.Tests/CreatorRenderSpecTests.cs');
    assert.equal((tests.match(/\[Fact\]/g) ?? []).length, 6, 'CreatorRenderSpecTests precisa cobrir os 6 caminhos');
    assert.match(tests, /BalloonsOf_keeps_resolved_data_from_the_render_override/);
    assert.match(tests, /StoredBalloon_keeps_the_contract_data_fields_only/);
  });

  it('CS-001 web: contrato e prévia preferem o data resolvido ao factRef', () => {
    const contracts = stripComments(read(`${WEB}/domain/creator-contracts.ts`));
    assert.match(contracts, /export const creatorBalloonDataSchema = z\.object\(\{\s*value: z\.string\(\)\.min\(1\),\s*unit: z\.string\(\)\.optional\(\),/);
    assert.match(contracts, /data: creatorBalloonDataSchema\.optional\(\)/);
    assert.match(contracts, /markdown: z\.string\(\)\.optional\(\)/);
    assert.match(contracts, /html: z\.string\(\)\.optional\(\)/);

    const editor = stripComments(read(`${WEB}/domain/creator-editor.ts`));
    assert.match(editor, /if \(balloon\.data\) return \{ ok: true, data: balloon\.data \}/);
    assert.match(editor, /const resolved = balloonDataOf\(balloon, input\.facts\)/);
    assert.match(read(`${WEB}/domain/creator-editor.test.ts`), /usa o data já resolvido do balão/);
  });

  it('CS-002 previa: prévia com o motor do render e markdown como texto puro', () => {
    const view = stripComments(read(`${WEB}/presentation/pages/business/business-creator-view.tsx`));
    assert.match(view, /import \{ BusinessCreatorPreview \} from '\.\/business-creator-preview'/);
    assert.match(view, /<BusinessCreatorPreview input=\{input\} \/>/);
    assert.match(view, /<details className="fluxo-creator-markdown">/);
    assert.match(view, /<pre>\{markdown\}<\/pre>/);
    assert.doesNotMatch(view, /dangerouslySetInnerHTML/);

    const queue = stripComments(read(`${WEB}/presentation/pages/business/use-creator-project-queue.ts`));
    assert.match(queue, /setCopyHtml\(copy\.html \?\? null\)/);
    assert.match(queue, /setCopyMarkdown\(copy\.markdown \?\? null\)/);

    const editor = stripComments(read(`${WEB}/presentation/pages/business/business-creator-editor.tsx`));
    assert.match(editor, /viewport=\{viewport \?\? config\.viewportPresets\[0\]\}/);
    assert.match(editor, /copyMarkdown=\{queue\.copyMarkdown\}/);
  });

  it('CS-003 ux: stepper, rótulo por fase, dado no render e limpar seleção', () => {
    const view = stripComments(read(`${WEB}/presentation/pages/business/business-creator-view.tsx`));
    assert.match(view, /className="fluxo-creator-stepper"/);
    assert.match(view, /aria-label="Progresso do Creator"/);
    assert.match(view, /'polling-copy': 'Copy na fila do worker/);
    assert.match(view, /montando no servidor/);
    assert.match(view, /1\. Formato/);
    assert.match(view, /3\. PNG/);

    const steps = stripComments(read(`${WEB}/presentation/pages/business/business-creator-steps.tsx`));
    // Sem a etapa "4. Copy": o dado da ficha sai no balão do render (DataBadge do pacote), não em formulário.
    assert.doesNotMatch(steps, /export function CopySection/);
    assert.match(steps, /selection\.maxIndicators/);
    const badge = read('packages/creator-render/src/components/DataBadge.tsx');
    assert.match(badge, /dataValueText|dataFooterText|data\?\.label/);

    const combobox = stripComments(read(`${WEB}/presentation/pages/business/business-creator-combobox.tsx`));
    assert.match(combobox, /className="fluxo-combobox-clear"/);

    const css = stripComments(read(`${WEB}/presentation/styles/platform.css`));
    for (const cls of ['.fluxo-creator-stepper {', '.fluxo-creator-authoring {', '.fluxo-creator-markdown pre {', '.fluxo-combobox-clear {']) {
      assert.ok(css.includes(cls), `platform.css sem ${cls}`);
    }
  });

  it('CS-004 entrega: BRD e fluxo prontos e gates registrados no backlog', () => {
    for (const file of ['brd.md', 'fluxo-usuario.md']) {
      const path = `${DELIVERY}/${file}`;
      assert.ok(exists(path), `${file} ausente`);
      const text = read(path);
      assert.match(text, /^Status:\s*ready\s*$/im, `${file} sem Status: ready`);
      assert.doesNotMatch(text, /\(Por que a feature existe/, `${file} ainda com o rascunho do template`);
    }
    const backlog = JSON.parse(read(`${DELIVERY}/backlog.json`));
    const ids = new Set((backlog.gates ?? []).map((gate) => gate.id));
    for (const id of ['CS-001-WORKER', 'CS-001-BACKEND', 'CS-001-WEB', 'CS-002-PREVIA', 'CS-003-UX']) {
      assert.ok(ids.has(id), `gate ${id} ausente no backlog`);
    }
  });
});
