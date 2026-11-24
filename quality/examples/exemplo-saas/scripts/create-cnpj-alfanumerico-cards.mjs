#!/usr/bin/env node
// Cria cards no Jira para o conjunto de refactors CNPJ Alfanumérico 2026
// Lê credenciais do .env do projeto.
//
// Uso:  node scripts/jira/create-cnpj-alfanumerico-cards.mjs [--dry-run]
import path from 'node:path';
import { loadEnv } from './load-env.mjs';
import { createClient } from './jira-client.mjs';
import { cardLabels } from '../../quality/delivery/lib.mjs';

// ── carregar .env ─────────────────────────────────────────────────────────────
const ROOT = path.resolve(import.meta.dirname, '..', '..');
loadEnv(ROOT);

const DRY_RUN = process.argv.includes('--dry-run');
const PROJECT_KEY = process.env.JIRA_PROJECT_KEY ?? 'OFLUXO';
const jira = createClient();

// ── helper para montar description em ADF ────────────────────────────────────
function adf(paragraphs) {
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map((text) => ({
      type: 'paragraph',
      content: [{ type: 'text', text }],
    })),
  };
}

// ── tasks ─────────────────────────────────────────────────────────────────────
const TASKS = [
  {
    summary: 'P1 — .NET: aceitar CNPJ alfanumérico na validação de domínio',
    priority: 'High',
    description: adf([
      'A Instrução Normativa RFB nº 2.229/2024 introduz CNPJs alfanuméricos a partir de 01/07/2026. O .NET rejeita qualquer letra com HTTP 422.',
      'Arquivo: backend/src/Exemplo SaaS.Api/Modules/Businesses/Business.cs',
      'Alterações: (1) Trocar Regex([^0-9]+) por Regex([^0-9A-Z]+) na normalização de CNPJ. (2) Atualizar mensagem de erro: "CNPJ must contain 14 alphanumeric characters." (3) Adicionar testes em DomainTests.cs com CNPJ alfanumérico válido (ex: 12ABC3450001DE35) e inválido.',
      'Impacto sem a mudança: 100% dos novos cadastros de negócios a partir de jul/2026 retornam 422 Unprocessable. Nenhuma migração de banco necessária — varchar(14) já aceita letras.',
    ]),
    targetStatus: 'To Do',
  },
  {
    summary: 'P1 — Flutter cnpj_utils: aceitar letras no input e normalização',
    priority: 'High',
    description: adf([
      'A Instrução Normativa RFB nº 2.229/2024 introduz CNPJs alfanuméricos a partir de 01/07/2026. O Flutter destrói letras antes de enviar.',
      'Arquivo principal: lib/shared/utils/cnpj_utils.dart',
      'Alterações: (1) normalizeCnpj: trocar RegExp(r"\\D") por RegExp(r"[^0-9A-Za-z]"). (2) CnpjInputFormatter: aceitar letras maiúsculas/minúsculas e normalizar para maiúsculo. (3) hasCompleteCnpj: verificar comprimento após strip alfanumérico. (4) cnpjLengthErrorMessage: "O CNPJ deve conter 14 caracteres." (em vez de "dígitos").',
      'Impacto sem a mudança: usuário não consegue digitar nem enviar CNPJ alfanumérico. O valor é silenciosamente truncado e a validação falha com mensagem enganosa.',
    ]),
    targetStatus: 'To Do',
  },
  {
    summary: 'P1 — Flutter: aplicar CnpjInputFormatter na tela de claim ownership',
    priority: 'High',
    description: adf([
      'A tela business_claim_ownership_screen.dart usa TextEditingController sem CnpjInputFormatter, diferente da tela de verificação que já tem o formatter. Omissão identificada durante auditoria CNPJ alfanumérico.',
      'Arquivo: lib/features/business_accounts/presentation/business_claim_ownership_screen.dart',
      'Alteração: aplicar CnpjInputFormatter() nos inputFormatters do TextField de CNPJ, exatamente como em business_cnpj_verification_screen.dart. Após o fix de cnpj_utils.dart (tarefa irmã), o formatter já aceitará letras automaticamente.',
      'Impacto sem a mudança: campo aceita texto livre sem máscara, podendo enviar CNPJ malformado ou com letras destruídas antes do submit.',
    ]),
    targetStatus: 'To Do',
  },
  {
    summary: 'P1 — Site público: aceitar CNPJ alfanumérico no formulário',
    priority: 'High',
    description: adf([
      'A Instrução Normativa RFB nº 2.229/2024 introduz CNPJs alfanuméricos a partir de 01/07/2026. O site público remove letras antes do envio.',
      'Arquivo: ofluxo_site/src/platform/presentation/pages/domain-pages.tsx',
      'Alterações: (1) Validação do botão: trocar cnpj.replace(/\\D/g, "").length !== 14 por cnpj.replace(/[^0-9A-Za-z]/g, "").length !== 14. (2) Payload enviado: trocar cnpj.replace(/\\D/g, "") por cnpj.replace(/[^0-9A-Za-z]/g, "").toUpperCase(). (3) Input HTML: remover inputMode="numeric" se presente.',
      'Impacto sem a mudança: botão permanece desabilitado para CNPJs alfanuméricos; letras são perdidas no payload enviado ao backend.',
    ]),
    targetStatus: 'To Do',
  },
  {
    summary: 'P1 — Functions businesses.ts: substituir strip inline por normalizeCnpj',
    priority: 'High',
    description: adf([
      'O arquivo functions/src/features/businesses.ts linha ~1118 usa normalizedRawDocument.replace(/\\D/g, "") — strip inline de dígitos, ignorando o utilitário compartilhado normalizeCnpj de identity/shared/normalization.ts que já aceita alfanumérico.',
      'Arquivo: functions/src/features/businesses.ts',
      'Alteração: substituir o replace(/\\D/g, "") pela chamada a normalizeCnpj() do módulo compartilhado. Verificar demais ocorrências de /\\D/g em businesses.ts.',
      'Impacto sem a mudança: a camada de businesses.ts rejeita ou trunca CNPJs alfanuméricos mesmo depois das demais correções, causando inconsistência entre os fluxos de identity e businesses.',
    ]),
    targetStatus: 'To Do',
  },
  {
    summary: 'P2 — Functions audit.ts: detectar CNPJ alfanumérico na redação de logs',
    priority: 'Medium',
    description: adf([
      'A redação automática de CNPJ em logs (functions/src/identity/shared/audit.ts) detecta apenas sequências de 14 dígitos consecutivos: if (digits.length === 14) return "[REDACTED_CNPJ]". Um CNPJ alfanumérico não é detectado por essa lógica e pode vazar em valores livres de log.',
      'Arquivo: functions/src/identity/shared/audit.ts',
      'Alteração: adicionar verificação complementar de padrão 14-char alfanumérico uppercase em valores de log — ex: if (/\\b[0-9A-Z]{14}\\b/.test(val) && !/^\\d+$/.test(val)) return "[REDACTED_CNPJ]". Manter a detecção numérica existente. Não substituir — as duas precisam coexistir.',
      'Impacto sem a mudança: CNPJs alfanuméricos podem aparecer em plaintext em logs de produção, violando a política de privacidade (SENSITIVE_KEY_FRAGMENTS cobre apenas valores cuja chave contém "cnpj").',
    ]),
    targetStatus: 'To Do',
  },
  {
    summary: 'P3 — .NET: testes de regressão para CNPJ alfanumérico',
    priority: 'Low',
    description: adf([
      'Os testes de domínio em DomainTests.cs cobrem apenas CNPJs numéricos. Após o refactor de Business.cs (tarefa P1 irmã), adicionar casos de cobertura.',
      'Arquivo: backend/tests/Exemplo SaaS.Api.Tests/DomainTests.cs',
      'Casos a adicionar: (1) CNPJ alfanumérico válido (ex: "12ABC3450001DE35") → aceito, status Pending. (2) CNPJ com letra minúscula (ex: "12abc3450001de35") → aceito após normalização para maiúsculo. (3) CNPJ alfanumérico com menos de 14 chars → rejeita "invalid_cnpj". (4) CNPJ com letras proibidas pela RF (I, O, Q, F) → definir comportamento (aceitar ou rejeitar).',
      'Dependência: completar o refactor de Business.cs antes.',
    ]),
    targetStatus: 'To Do',
  },
  {
    summary: 'Backlog — Monitorar Bacen: chave PIX tipo CNPJ alfanumérico',
    priority: 'Low',
    description: adf([
      'O validador de chave PIX tipo CNPJ em functions/src/payments/validators/pix_keys.ts usa algoritmo mod-11 exclusivamente numérico e strip /\\D/g. Se o Banco Central do Brasil passar a aceitar CNPJs alfanuméricos como chave PIX, esse validador precisará ser atualizado.',
      'Status atual: a Resolução BCB nº 1/2020 ainda define chave CNPJ como os 14 dígitos do CNPJ. O Bacen não publicou resolução específica sobre o tema até 2026-10-01.',
      'Ação: não alterar o código agora. Monitorar publicações do Bacen referentes ao PIX e CNPJ alfanumérico. Abrir nova tarefa de implementação quando (e se) uma resolução for publicada.',
      'Arquivos impactados quando/se necessário: functions/src/payments/validators/pix_keys.ts (algoritmo mod-11, normalização, máscara).',
    ]),
    targetStatus: 'To Do',
  },
];

/** Monta os fields do card com a categoria da feature (labels normalizadas). */
function cardFields(task, issueType) {
  return {
    project: { key: PROJECT_KEY },
    issuetype: { id: issueType.id },
    summary: task.summary,
    description: task.description,
    labels: cardLabels(null, null, { featureSlug: 'cnpj-alfanumerico', categories: ['2026'] }),
  };
}

async function run() {
  console.log('==> Verificando credenciais Jira...');
  const me = await jira.getMyself();
  console.log(`    Autenticado como: ${me.displayName} (${me.emailAddress})`);

  const proj = await jira.getProject(PROJECT_KEY);
  console.log(`    Projeto: ${proj.key} — ${proj.name}`);

  const types = proj.issueTypes ?? [];
  const issueType =
    types.find((t) => t.name === 'Story') ??
    types.find((t) => t.name === 'Task') ??
    types[0];
  if (!issueType) throw new Error('Nenhum issue type encontrado no projeto');
  console.log(`    Issue type: ${issueType.name} (id ${issueType.id})\n`);

  const priorities = { High: null, Medium: null, Low: null };

  if (DRY_RUN) {
    for (const task of TASKS) {
      console.log(`[dry-run] ${task.priority.padEnd(6)} "${task.summary}"`);
    }
    return;
  }

  const created = [];

  for (const task of TASKS) {
    process.stdout.write(`==> [${task.priority}] "${task.summary.slice(0, 70)}…"  `);
    const issue = await jira.createIssue(cardFields(task, issueType));
    console.log(`→ ${issue.key}`);
    created.push({ key: issue.key, summary: task.summary });
  }

  console.log('\n✓ Cards criados:');
  const host = new URL(process.env.JIRA_BASE_URL).host;
  for (const { key, summary } of created) {
    console.log(`  ${key}  ${summary.slice(0, 60)}`);
    console.log(`       https://${host}/browse/${key}`);
  }
}

run().catch((err) => {
  console.error('Erro:', err.message);
  process.exit(1);
});
