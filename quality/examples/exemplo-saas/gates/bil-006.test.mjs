// Gates BIL-006 — segredos, jobs, promoção por digest e janela de teste em produção (D12: sem homologação).
// Sem `plan`, sem `apply` e sem GCP: `terraform validate` local e leitura estrutural do HCL e do workflow.
// ANTES da implementação cada gate DEVE falhar.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-10-31-billing-asaas-mercadopago BIL-006 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ROOT, exists, read } from './bil-gate-helper.mjs';
import { attribute, blocks, buildApi, expandLocals, resources, runApi, stripComments, terraformValidate } from './bil-006-gate-helper.mjs';

const TF = 'infra/gcp/terraform';
const MODULE = `${TF}/modules/environment`;
const PROD = `${TF}/environments/prod`;
const WORKFLOW = '.github/workflows/backend-deploy.yml';
const RUNBOOK = 'docs/billing/RUNBOOK_BILLING.md';
const JOB = 'billing-reconcile';
const JOB_RESOURCE = 'fluxo-billing-reconcile';
const API_IMAGE = '${{ steps.build.outputs.api_image }}';

const SECRETS = [
  'fluxo-asaas-api-key', 'fluxo-asaas-webhook-token', 'fluxo-app-crypto-key', 'fluxo-app-crypto-hmac-key',
  'fluxo-mercadopago-client-secret', 'fluxo-mercadopago-webhook-secret',
];
// Chaves lidas pela API (ApplicationCryptoOptions, BillingOptions, AsaasOptions). Nome errado só apareceria em produção.
const PLAIN_ENV = ['Billing__Enabled', 'Billing__Provider', 'Asaas__BaseUrl', 'ApplicationCrypto__ActiveKeyId'];
const SECRET_ENV = ['Asaas__ApiKey', 'Asaas__WebhookToken', 'ApplicationCrypto__HmacKey', 'ApplicationCrypto__Keys__'];

const hcl = (rel) => stripComments(read(rel));
const billing = () => hcl(`${MODULE}/billing.tf`);
const moduleSource = () => [`${MODULE}/billing.tf`, `${MODULE}/main.tf`].map(hcl).join('\n');
const variable = (source, name) => blocks(source, `variable\\s+"${name}"`)[0];

function moduleDefault(name) {
  const body = variable(hcl(`${MODULE}/variables.tf`), name);
  assert.ok(body, `variável ${name} ausente em ${MODULE}/variables.tf`);
  return attribute(body, 'default');
}

/** Valor passado por prod ao módulo, resolvendo `var.x` pelo default de prod. `undefined` se prod não passa nada. */
function prodValue(name) {
  const body = blocks(hcl(`${PROD}/main.tf`), 'module\\s+"environment"')[0];
  const expression = attribute(body, name);
  const reference = expression?.match(/^var\.(\w+)$/);
  if (!reference) return expression;
  const declared = variable(hcl(`${PROD}/variables.tf`), reference[1]);
  assert.ok(declared, `var.${reference[1]} não declarada em prod`);
  const value = attribute(declared, 'default');
  assert.notEqual(value, undefined, `var.${reference[1]} precisa de default em prod: o padrão não pode depender de quem roda o apply`);
  return value;
}

const service = () => resources(hcl(`${MODULE}/main.tf`), 'google_cloud_run_v2_service', 'api')[0];

function billingJob() {
  const [job] = resources(billing(), 'google_cloud_run_v2_job', 'billing');
  assert.ok(job, 'google_cloud_run_v2_job.billing ausente em billing.tf');
  return job;
}

/** Blocos env, fixos e dinâmicos, com os locals que usam já expandidos. */
function envBlocks(body) {
  const source = moduleSource();
  const fixed = blocks(body, 'env').map((text) => ({ dynamic: false, text: expandLocals(text, source) }));
  const dynamic = blocks(body, 'dynamic\\s+"env"').map((text) => ({ dynamic: true, text: expandLocals(text, source) }));
  return [...fixed, ...dynamic];
}

const envWith = (body, name) => envBlocks(body).filter((block) => block.text.includes(name));

/** Nome Terraform do recurso que declara o segredo, aceitando um recurso por segredo ou `for_each` sobre um local. */
function secretResource(id) {
  const source = moduleSource();
  for (const [, name] of source.matchAll(/resource\s+"google_secret_manager_secret"\s+"(\w+)"/g)) {
    const [body] = resources(source, 'google_secret_manager_secret', name);
    if (expandLocals(body, source).includes(id)) return name;
  }
  return undefined;
}

// Padrões de credencial real. As strings são montadas para o próprio gate não parecer um vazamento.
const SECRET_PATTERNS = [
  new RegExp(`\\${'$'}${'aact'}_[A-Za-z0-9_-]{8,}`),
  new RegExp(`\\b${'APP'}_USR-\\d{6,}`),
  new RegExp(`\\b${'TEST'}-\\d{6,}`),
  new RegExp(`-----BEGIN [A-Z ]*${'PRIVATE'} KEY-----`),
  /\bsecret_data(_wo)?\s*=/,
  /\bvalue\s*=\s*"[A-Za-z0-9_+/-]{32,}={0,2}"/,
];

const leaks = (text) => SECRET_PATTERNS.filter((pattern) => pattern.test(text)).map(String);

function versionedFiles() {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '--', TF, '.github/workflows', 'docs/billing'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ls-files falhou: ${r.stderr}`);
  return r.stdout.split('\n').filter((f) => /\.(tf|tfvars|tfvars\.example|ya?ml|md)$/.test(f) && exists(f) && !f.split('/').some((p) => p.startsWith('.env')));
}

function promotionStep() {
  const steps = read(WORKFLOW).split(/\n(?=\s+- (?:name|uses):)/);
  const step = steps.find((s) => /- name: Promover candidato/.test(s));
  assert.ok(step, 'passo "Promover candidato" ausente');
  return step.replace(/\\\n\s*/g, ' ');
}

test('BIL-006 terraform-validate: módulo, prod e demais consumidores do módulo passam sem backend', () => {
  terraformValidate([MODULE, PROD, `${TF}/environments/hml`, TF]);
});

test('BIL-006 terraform-validate: o que foi validado inclui os recursos de Billing', () => {
  assert.ok(exists(`${MODULE}/billing.tf`), `arquivo ausente: ${MODULE}/billing.tf`);
  const source = billing();
  const secrets = resources(source, 'google_secret_manager_secret').join('\n');
  for (const id of SECRETS) assert.ok(secretResource(id), `segredo ${id} ausente`);
  assert.match(secrets, /prevent_destroy\s*=\s*true/, 'perder uma chave de cifragem torna os dados ilegíveis');
  assert.equal(attribute(billingJob(), 'for_each'), 'var.billing_jobs');
  const [scheduler] = resources(source, 'google_cloud_scheduler_job', 'billing');
  assert.ok(scheduler, 'google_cloud_scheduler_job.billing ausente');
  assert.equal(attribute(scheduler, 'for_each'), 'var.billing_jobs');
  assert.match(scheduler, /oauth_token/, 'scheduler precisa chamar a Admin API autenticado');
  const invokers = resources(source, 'google_cloud_run_v2_job_iam_member').join('\n');
  assert.match(invokers, /roles\/run\.invoker/, 'sem invoker o scheduler toma 403 em silêncio');
  assert.match(invokers, /google_cloud_run_v2_job\.billing/);
});

test('BIL-006 sem-segredo-versionado: o detector reconhece credencial em fixture', () => {
  const fake = 'A1b2C3d4E5f6G7h8I9j0';
  for (const sample of [`${'$'}${'aact'}_hmlg_${fake}`, `${'APP'}_USR-1234567-abc`, `${'TEST'}-1234567-abc`, `value = "${fake}${fake}"`, 'secret_data = var.x']) {
    assert.notDeepEqual(leaks(sample), [], `detector não viu: ${sample.slice(0, 12)}`);
  }
  assert.deepEqual(leaks('value = "https://api.asaas.com/v3"'), [], 'URL pública não é segredo');
});

test('BIL-006 sem-segredo-versionado: nada de credencial em .tf, .tfvars, workflow ou runbook', () => {
  const files = versionedFiles();
  assert.ok(files.includes(`${MODULE}/billing.tf`), 'billing.tf fora da varredura');
  assert.ok(files.includes(WORKFLOW), 'workflow fora da varredura');
  assert.ok(files.includes(RUNBOOK), 'runbook fora da varredura');
  assert.deepEqual(files.flatMap((file) => leaks(read(file)).map((id) => `${file}: ${id}`)), []);
  assert.deepEqual(resources(billing(), 'google_secret_manager_secret_version'), [], 'só o contêiner do segredo: valor nunca passa pelo Terraform');
});

test('BIL-006 sem-segredo-versionado: versões numeradas, nunca latest', () => {
  const declared = [hcl(`${MODULE}/variables.tf`), hcl(`${PROD}/variables.tf`)].join('\n');
  const names = [...declared.matchAll(/variable\s+"(\w*(?:asaas|crypto|mercadopago)\w*version\w*)"/g)].map((m) => m[1]);
  assert.ok(new Set(names).size >= SECRET_ENV.length, `variáveis de versão insuficientes: ${[...new Set(names)]}`);
  for (const name of new Set(names)) {
    const bodies = blocks(declared, `variable\\s+"${name}"`);
    assert.ok(bodies.every((b) => !/"latest"/.test(attribute(b, 'default') ?? '')), `${name} não pode assumir latest`);
    assert.ok(bodies.some((b) => /\[1-9\]\[0-9\]\*/.test(b)), `${name} sem validação de versão numerada`);
  }
  for (const body of [service(), billingJob()]) {
    for (const name of SECRET_ENV) {
      for (const block of envWith(body, name)) assert.doesNotMatch(block.text, /version\s*=\s*"latest"/, name);
    }
  }
});

test('BIL-006 env-segredos: serviço e jobs recebem as chaves que a API lê, segredo só por secret_key_ref', () => {
  for (const [where, body] of [['fluxo-api', service()], ['jobs de Billing', billingJob()]]) {
    for (const name of PLAIN_ENV) assert.notDeepEqual(envWith(body, name), [], `${where} sem ${name}`);
    for (const name of SECRET_ENV) {
      const found = envWith(body, name);
      assert.notDeepEqual(found, [], `${where} sem ${name}`);
      for (const block of found) assert.match(block.text, /secret_key_ref/, `${name} em ${where} precisa vir do Secret Manager`);
      for (const block of found.filter((b) => !b.dynamic)) assert.doesNotMatch(block.text, /(^|\n)\s*value\s*=/, `${name} com valor em texto`);
    }
  }
});

test('BIL-006 env-segredos: a API lê os seis segredos pela própria service account', () => {
  const source = moduleSource();
  const grants = [
    ...resources(source, 'google_secret_manager_secret_iam_binding'),
    ...resources(source, 'google_secret_manager_secret_iam_member'),
  ].map((text) => expandLocals(text, source)).filter((text) => /roles\/secretmanager\.secretAccessor/.test(text) && /workload\["api"\]/.test(text));
  const covered = grants.join('\n');
  for (const id of SECRETS) {
    const name = secretResource(id);
    assert.ok(name, `segredo ${id} ausente`);
    assert.match(covered, new RegExp(`google_secret_manager_secret\\.${name}\\b`), `IAM de leitura não cobre ${id}`);
  }
});

test('BIL-006 job-encerra: --job=billing-reconcile sai com 0 em Testing e Production sem abrir porta', async () => {
  buildApi();
  for (const environment of ['Testing', 'Production']) {
    const r = await runApi([`--job=${JOB}`], { environment, waitMs: 12_000 });
    const where = `${environment}:\n${r.log.split('\n').slice(-12).join('\n')}`;
    assert.equal(r.opened, false, `abriu porta em ${where}`);
    assert.doesNotMatch(r.log, /Now listening on/, `subiu o Kestrel em ${where}`);
    assert.equal(r.timedOut, false, `não encerrou: o job ficaria preso até o tempo limite em ${where}`);
    assert.equal(r.code, 0, `saiu com ${r.code} em ${where}`);
    assert.match(r.log, new RegExp(JOB), `sem log do job em ${where}`);
  }
});

test('BIL-006 job-encerra: sem o argumento a API continua subindo', async () => {
  buildApi();
  const r = await runApi([], { environment: 'Testing', waitMs: 15_000, stopWhenOpen: true });
  assert.equal(r.opened, true, `Kestrel não abriu a porta:\n${r.log.split('\n').slice(-12).join('\n')}`);
});

test('BIL-006 job-encerra: o Cloud Run Job passa o argumento que a API reconhece', () => {
  assert.equal(attribute(billingJob(), 'for_each'), 'var.billing_jobs');
  assert.match(billingJob(), /args\s*=\s*\[\s*"--job=\$\{each\.key\}"\s*\]/);
});

test('BIL-006 mesmo-digest: job nasce com a imagem da API e o Terraform não reverte o digest', () => {
  const job = billingJob();
  assert.match(job, /\bname\s*=\s*"fluxo-\$\{each\.key\}"/, `o workflow promove ${JOB_RESOURCE}`);
  assert.match(job, /image\s*=\s*var\.cloud_run_image\b/);
  assert.match(job, /service_account\s*=\s*google_service_account\.workload\["api"\]\.email/);
  const lifecycle = blocks(job, 'lifecycle')[0] ?? '';
  assert.match(lifecycle, /ignore_changes[\s\S]*containers\[0\]\.image/, 'sem isto cada apply volta o job para var.cloud_run_image');
});

test('BIL-006 mesmo-digest: promover candidato atualiza o job com o digest publicado', () => {
  const step = promotionStep();
  assert.match(step, new RegExp(`\\b${JOB_RESOURCE}\\b`), `passo de promoção não cita ${JOB_RESOURCE}`);
  const updates = [...step.matchAll(/gcloud run jobs update (\S+)([^\n]*)/g)];
  const billingUpdate = updates.find(([, target]) => target === JOB_RESOURCE
    || (/^"?\$\{?\w+\}?"?$/.test(target) && new RegExp(`for \\w+ in [^\\n]*\\b${JOB_RESOURCE}\\b`).test(step)));
  assert.ok(billingUpdate, `sem gcloud run jobs update para ${JOB_RESOURCE}`);
  assert.ok(billingUpdate[2].includes(`--image="${API_IMAGE}"`), `update sem o digest da API: ${billingUpdate[0].slice(0, 160)}`);
  assert.ok(step.indexOf('update-traffic') < step.indexOf(billingUpdate[0]), 'job só muda depois de a revisão receber tráfego');
  assert.doesNotMatch(step, /\|\|\s*(true|:)|continue-on-error/, 'falha ao promover o job não pode passar em silêncio');
});

test('BIL-006 padrao-desligado: produção nasce com Billing desligado e URL real do Asaas', () => {
  assert.equal(moduleDefault('billing_enabled'), 'false');
  assert.equal(prodValue('billing_enabled'), 'false', 'prod declara billing_enabled = false');
  assert.equal(prodValue('asaas_base_url'), '"https://api.asaas.com/v3"');
  assert.doesNotMatch(moduleDefault('asaas_base_url') ?? '', /sandbox/, 'sandbox só entra por decisão explícita de janela');
  assert.doesNotMatch(hcl(`${PROD}/terraform.tfvars.example`), /billing_enabled\s*=\s*true|api-sandbox/);
  assert.equal(JSON.parse(read('backend/src/Exemplo SaaS.Api/appsettings.json')).Billing.Enabled, false);
});

test('BIL-006 padrao-desligado: schedulers nascem pausados', () => {
  assert.equal(moduleDefault('billing_jobs_paused'), 'true');
  assert.equal(prodValue('billing_jobs_paused') ?? moduleDefault('billing_jobs_paused'), 'true', 'prod não pode despausar antes de a imagem com o ramo estar publicada');
  assert.deepEqual(moduleDefault('billing_jobs')?.replace(/\s+/g, ' '), '{ billing-reconcile = "0 * * * *" }');
  const [scheduler] = resources(billing(), 'google_cloud_scheduler_job', 'billing');
  assert.ok(scheduler, 'google_cloud_scheduler_job.billing ausente');
  assert.equal(attribute(scheduler, 'paused'), 'var.billing_jobs_paused');
});

test('BIL-006 padrao-desligado: desligado, o serviço não referencia versão de segredo que ainda não existe', () => {
  const body = service();
  const [enabled] = envWith(body, 'Billing__Enabled');
  assert.ok(enabled, 'fluxo-api sem Billing__Enabled');
  assert.match(enabled.text, /var\.billing_enabled/, 'Billing__Enabled segue a variável, sem valor fixo');
  const [provider] = envWith(body, 'Billing__Provider');
  assert.ok(provider, 'fluxo-api sem Billing__Provider');
  assert.doesNotMatch(provider.text, /"stub"/, 'Billing:Enabled com stub é recusado em Production');
  for (const name of SECRET_ENV) {
    const found = envWith(body, name);
    assert.notDeepEqual(found, [], `fluxo-api sem ${name}`);
    for (const block of found) {
      assert.ok(block.dynamic, `${name} fixo no serviço: a revisão quebra enquanto o segredo não tem versão`);
      const forEach = attribute(blocks(body, 'dynamic\\s+"env"').find((text) => expandLocals(text, moduleSource()).includes(name)), 'for_each');
      assert.match(expandLocals(forEach, moduleSource()), /var\.billing_enabled/, `${name} precisa depender de billing_enabled`);
    }
  }
});

test('BIL-006 runbook: cobre rotação, falhas do PSP, janela em produção e passagem para a chave real', () => {
  const text = read(RUNBOOK);
  for (const [topic, pattern] of Object.entries({
    'giro do token do webhook': /fluxo-asaas-webhook-token[\s\S]*WebhookTokenPrevious|WebhookTokenPrevious[\s\S]*fluxo-asaas-webhook-token/,
    'giro da chave em 6 meses': /6 meses/,
    'chave expirada': /ACCESS_TOKEN_EXPIRED/,
    'fila parada': /15 falhas[\s\S]*14 dias|14 dias[\s\S]*15 falhas/,
    'formato da chave': /base64url[\s\S]*32 bytes|32 bytes[\s\S]*base64url/,
    'adicionar chave de cifragem': /chave de cifragem/i,
    'despausar schedulers': /despausar/i,
    'abrir a janela': /abrir[^\n]*janela|janela[^\n]*abrir/i,
    'fechar a janela': /billing_enabled\s*=\s*false/,
    'sandbox na janela': /https:\/\/api-sandbox\.asaas\.com\/v3/,
    'limpeza das linhas de teste': /billing_\*|billing_(customers|invoices|charges|subscriptions)/,
    'troca para a chave real': /https:\/\/api\.asaas\.com\/v3[\s\S]*aprova|aprova[\s\S]*https:\/\/api\.asaas\.com\/v3/i,
  })) assert.match(text, pattern, `runbook sem: ${topic}`);
});
