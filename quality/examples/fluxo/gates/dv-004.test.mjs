// Gates DV-004: o próprio harness fornece respostas gravadas do Claude e observa os payloads
// produzidos pelos módulos REAIS do worker. Não exige testes/marcadores do implementador.
// Baseline: node quality/delivery/eval.mjs docs/entregas/2026-10-21-debate-ao-vivo DV-004 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WORKER } from './dv-worker-gate-helper.mjs';
import { runExtractionSpec } from './dv-004-gate-helper.mjs';

test('DV-004 extraction-fixtures: cinco respostas gravadas produzem payloads completos e índices exatos', () => {
  runExtractionSpec('extraction-fixtures.vitest.ts', [
    'preserva número e citação com offsets reais',
    'envia promessa concreta com prioridade três',
    'envia opinião como descartada',
    'envia pergunta ao destinatário conhecido',
    'liga resposta evasiva à pergunta aberta',
  ]);
});

test('DV-004 output-validation: revalida schema, citações, números, enums, vínculos e falhas do modelo', () => {
  runExtractionSpec('output-validation.vitest.ts', [
    'schema rejeita campos ausentes, null, prioridade inválida e enums desconhecidos',
    'remove citação inventada e conta invalidItems',
    'calcula offsets UTF-16 preservando espaços originais',
    'rebaixa número inventado para não verificável',
    'reconhece números em milhões e por extenso sem falso descarte',
    'normaliza caixa de enums antes da validação final',
    'anula destinatário e pergunta anterior desconhecidos',
    'remove textos vazios e limita resumo a 280 caracteres',
    'rejeita contradição entre checkable e discardReason',
    'refusal gera auditoria sem extração nem retry',
    'max_tokens repete uma vez com 4096 e audita ambas as chamadas',
    'max_tokens persistente termina sem extração',
    'JSON inválido gera invalid_output sem extração',
    'revalida parsed_output em vez de confiar na resposta do SDK',
    'falha ao registrar ai-run impede envio da extração',
    'não chama modelo nem API para falante não confirmado',
  ]);
});

test('DV-004 ai-run-cache-neutral: Vertex ADC, prefixo estável, schema estruturado, rastreabilidade e retry', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(WORKER, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies?.['@anthropic-ai/vertex-sdk'], 'SDK Vertex precisa ser dependência de produção');
  assert.ok(pkg.scripts?.['eval:extract'], 'avaliação live precisa ter comando explícito (não roda neste gate)');
  const env = fs.readFileSync(path.join(WORKER, '.env.example'), 'utf8');
  for (const key of ['VERTEX_PROJECT_ID', 'VERTEX_REGION', 'EXTRACTION_MODEL']) {
    assert.match(env, new RegExp(`^${key}=`, 'm'), `.env.example precisa declarar ${key}`);
  }
  runExtractionSpec('ai-run-cache.vitest.ts', [
    'fábrica usa AnthropicVertex com projeto e região sem chave Anthropic',
    'requisição usa modelo configurado, JSON Schema e cache no último bloco',
    'prefixo e versão são idênticos entre candidatos e hash corresponde ao texto',
    'envia só as seis últimas falas, pergunta aberta e fala-alvo no contexto variável',
    'ai-run antecede extração, preserva tokens de cache e hash do corpo',
    'Haiku 4.5 omite effort',
    '408, 429 e 503 têm retry limitado com backoff e auditoria por chamada',
    'erro permanente não tem retry e registra falha',
  ]);
});

test('DV-004 lease-loop: processa offsets em série e descarta lease vencido', () => {
  runExtractionSpec('lease-loop.vitest.ts', [
    'processa somente falantes confirmados em ordem de offset sem concorrência',
    '409 lease_expired não repete envio nem publica outro resultado',
    'encerra o lote quando o lease vence',
    'lease vazio não chama o extrator',
  ]);
});
