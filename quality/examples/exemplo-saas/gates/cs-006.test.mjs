// Gate de entrega CS-006: cadeia de provedores do LLM (nível gratuito → Vertex AI → Anthropic).
// Estático de propósito: lê a configuração do worker, o cliente, o .env.example e o script de deploy. A chamada real
// é provada pelos testes de unidade do worker (gate CS-006-CADEIA) e ponta a ponta na homologação (CS-005).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { read, stripComments } from './fc-gate-helper.mjs';

const WORKER = 'services/creator-worker/src';

describe('CS-006 cadeia de provedores do LLM', () => {
  it('CS-006 cadeia: config lê o CSV do gratuito e a chave, com o endpoint do GroqCloud como 1º degrau', () => {
    const config = stripComments(read(`${WORKER}/config.ts`));
    assert.match(config, /CREATOR_LLM_FREE_MODEL: modelList/);
    assert.match(config, /CREATOR_LLM_FREE_API_KEY: z\.preprocess/);
    assert.match(config, /export const FREE_LLM_BASE_URL = 'https:\/\/api\.groq\.com\/openai\/v1'/);
    // CSV: separa por vírgula e descarta item em branco (espaço em volta não vira modelo).
    assert.match(config, /const modelList = z\.preprocess/);
    assert.match(config, /\.split\(','\)\s*\.map\(\(part\) => part\.trim\(\)\)\.filter\(\(part\) => part\.length > 0\)/);
    // Sem chave OU sem lista não existe degrau gratuito: a cadeia começa no primário.
    assert.match(config, /free:\s*\n\s*e\.CREATOR_LLM_FREE_API_KEY && e\.CREATOR_LLM_FREE_MODEL\.length > 0/);
  });

  it('CS-006 cadeia: a ordem é gratuito (1 tentativa por modelo do CSV) → Vertex AI → Anthropic', () => {
    const client = stripComments(read(`${WORKER}/ai/llm-client.ts`));
    assert.match(client, /export function providerChain\(tiers: ChainTiers, model\?: string, fallbackModel\?: string\): Attempt\[\]/);
    assert.match(client, /tiers\.freeModels\.map\(\(name\) => \(\{ provider: tiers\.free as LlmProviderConfig, model: name, withFormat: false, label: 'free' \}\)\)/);
    assert.match(client, /label: 'primary' \}/);
    assert.match(client, /label: 'fallback' \}/);
    assert.match(client, /return \[\.\.\.free, primary, \.\.\.fallback\]/);
  });

  it('CS-006 cadeia: só falha de provedor (ou resposta vazia) desce a cadeia, e o gratuito tem orçamento próprio', () => {
    const client = stripComments(read(`${WORKER}/ai/llm-client.ts`));
    // Erro de pedido (4xx) é nosso: para na hora. Abort da pista também não gasta o resto da cadeia.
    assert.match(client, /export function chainDown\(error: unknown\): boolean \{/);
    assert.match(client, /error\.code === 'llm_response_invalid'/);
    assert.match(client, /if \(!chainDown\(error\) \|\| signal\?\.aborted \|\| index === attempts\.length - 1\) throw error;/);
    // O degrau gratuito não pode comer o teto do kind (30 s): orçamento compartilhado, depois desce para o Vertex.
    assert.match(client, /const freeBudgetMs = options\.freeBudgetMs \?\? 8_000;/);
    assert.match(client, /if \(attempt\.label === 'free' && freeDeadline - now\(\) <= 0\) continue;/);
    // Sem response_format no gratuito/alternativo: nem todo OpenAI-compat aceita json_schema strict:false.
    assert.match(client, /withFormat: false, label: 'free'/);
    assert.match(client, /free\?: LlmTierConfig/);
  });

  it('CS-006 cadeia: runtime e wiring passam o degrau gratuito ao cliente', () => {
    const runtime = stripComments(read(`${WORKER}/ai/llm-runtime-config.ts`));
    assert.match(runtime, /free\?: \{ baseUrl: string; apiKey: string; models: string\[\] \}/);
    assert.match(runtime, /free: config\.llm\.free/);

    const index = stripComments(read(`${WORKER}/index.ts`));
    assert.match(index, /free: llmRuntime\.free/);
  });

  it('CS-006 cadeia: .env.example e deploy documentam e injetam as duas variáveis novas', () => {
    const envExample = read('.env.example');
    assert.match(envExample, /^CREATOR_LLM_FREE_MODEL=llama-3\.3-70b-versatile,openai\/gpt-oss-120b$/m);
    assert.match(envExample, /^CREATOR_LLM_FREE_API_KEY=$/m);

    const script = read('scripts/deploy/local/push-creator-llm.sh');
    assert.match(script, /CREATOR_LLM_FREE_MODEL CREATOR_LLM_FREE_API_KEY\)/);
    assert.match(script, /'CREATOR_LLM_FREE_API_KEY:creator_llm_free_api_key'/);
    assert.match(script, /CREATOR_LLM_FREE_API_KEY=creator_llm_free_api_key:latest/);
    assert.match(script, /env_pairs="[^"]*@CREATOR_LLM_FREE_MODEL=\$\{free_models\}"/);
    assert.match(script, /--update-env-vars "\^@\^\$\{env_pairs\}"/);
  });

  it('CS-006 cadeia: testes de unidade cobrem a ordem, a rotação do CSV e o erro de pedido', () => {
    const unit = read(`${WORKER}/ai/llm-client.test.ts`);
    assert.match(unit, /describe\('llm-client cadeia de provedores \(gratuito → Vertex AI → Anthropic\)'/);
    assert.match(unit, /1ª chamada vai para o nível gratuito/);
    assert.match(unit, /429 num modelo do CSV desce para o modelo seguinte do gratuito/);
    assert.match(unit, /gratuito e Vertex falham por provedor → a 3ª chamada é o Anthropic/);
    assert.match(unit, /erro de pedido no gratuito \(400\) é nosso: NÃO desce a cadeia/);
    assert.match(unit, /sem CREATOR_LLM_FREE_\* a cadeia começa no Vertex/);
    assert.match(unit, /orçamento do degrau gratuito esgotado desce para o Vertex/);
  });
});
