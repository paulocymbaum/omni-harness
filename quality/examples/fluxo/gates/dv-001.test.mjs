// Gate DV-001-TF-STATIC — infra do Debate ao Vivo em fluxo-ath (root Terraform prod-debates e scripts).
// ANTES da implementação este teste DEVE falhar: o root e os scripts ainda não existem.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-10-21-debate-ao-vivo DV-001 --baseline
//
// Contrato de CLI fixado por este gate (além da spec DV-001):
//   - infra/gcp/scripts/debates-api-config.sh [--apply]; projeto em PROJECT_ID (default fluxo-ath),
//     audience em API_OIDC_AUDIENCE (default https://fluxo-api-qkuhvcwkiq-rj.a.run.app);
//   - backend/deploy/jobs/deploy-debate-worker.sh PROJECT_ID REGION IMAGE.
// Nenhum caso chama o GCP: o gcloud é substituído por um falso que só grava os argumentos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TF_ROOT = path.join(ROOT, 'infra/gcp/terraform/environments/prod-debates');
const SCRIPTS = {
  importDebates: path.join(ROOT, 'infra/gcp/scripts/import-debates.sh'),
  validateDebates: path.join(ROOT, 'infra/gcp/scripts/validate-debates.sh'),
  apiConfig: path.join(ROOT, 'infra/gcp/scripts/debates-api-config.sh'),
  deployWorker: path.join(ROOT, 'backend/deploy/jobs/deploy-debate-worker.sh'),
};
const API_URL = 'https://fluxo-api-qkuhvcwkiq-rj.a.run.app';
const DIGEST = `sha256:${'a1'.repeat(32)}`;
const WORKER_IMAGE = `southamerica-east1-docker.pkg.dev/fluxo-ath/fluxo/fluxo-debate-worker@${DIGEST}`;

// ── HCL como texto ───────────────────────────────────────────────────────────

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)(#|\/\/).*$/, '$1'))
    .join('\n');
}

function loadRootHcl() {
  assert.ok(fs.existsSync(TF_ROOT), `root Terraform ausente: ${path.relative(ROOT, TF_ROOT)}`);
  const files = fs.readdirSync(TF_ROOT).filter((f) => f.endsWith('.tf'));
  for (const required of ['versions.tf', 'providers.tf', 'variables.tf', 'main.tf', 'outputs.tf']) {
    assert.ok(files.includes(required), `arquivo obrigatório ausente no root prod-debates: ${required}`);
  }
  return files.map((f) => stripComments(fs.readFileSync(path.join(TF_ROOT, f), 'utf8'))).join('\n');
}

/** Blocos `resource|data "<tipo>" "<nome>" { … }` com chaves balanceadas. */
function blocks(src, kind = 'resource') {
  const out = [];
  const re = new RegExp(`\\b${kind}\\s+"([\\w-]+)"\\s+"([\\w-]+)"\\s*\\{`, 'g');
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (; end < src.length; end++) {
      if (src[end] === '{') depth++;
      else if (src[end] === '}' && --depth === 0) break;
    }
    out.push({ type: m[1], name: m[2], body: src.slice(m.index, end + 1) });
  }
  return out;
}

const ofType = (src, type) => blocks(src).filter((b) => b.type === type);

// ── gcloud falso ─────────────────────────────────────────────────────────────

function fakeGcloud() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv001-gcloud-'));
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(log, '');
  const bin = path.join(dir, 'gcloud');
  fs.writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do printf '%s\\037' "$a" >> "${log}"; done\nprintf '\\n' >> "${log}"\nexit 0\n`);
  fs.chmodSync(bin, 0o755);
  return {
    env: (extra = {}) => ({ ...process.env, ...extra, PATH: `${dir}${path.delimiter}${process.env.PATH}` }),
    calls: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)
      .map((line) => line.split('\x1f').filter((a, i, arr) => i < arr.length - 1 || a !== '')),
  };
}

function runScript(script, args, env) {
  assert.ok(fs.existsSync(script), `script ausente: ${path.relative(ROOT, script)}`);
  const r = spawnSync('bash', [script, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.error, undefined, `script não executou: ${r.error?.message}`);
  return { status: r.status, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

function envVarsOf(call) {
  const values = call.filter((a) => a.startsWith('--update-env-vars=')).map((a) => a.slice('--update-env-vars='.length));
  const pairs = [];
  for (const v of values) {
    const custom = v.match(/^\^(.)\^/);
    const delim = custom ? custom[1] : ',';
    pairs.push(...(custom ? v.slice(3) : v).split(delim));
  }
  return pairs;
}

// ── 1. estático ──────────────────────────────────────────────────────────────

test('DV-001 estático: bucket de áudio privado, com UBLA e prevent_destroy, sem acesso público', () => {
  const src = loadRootHcl();
  const buckets = ofType(src, 'google_storage_bucket').filter((b) => /name\s*=\s*"fluxo-ath-debates-audio"/.test(b.body));
  assert.equal(buckets.length, 1, 'esperava exatamente um google_storage_bucket "fluxo-ath-debates-audio"');
  const bucket = buckets[0].body;
  assert.match(bucket, /public_access_prevention\s*=\s*"enforced"/);
  assert.match(bucket, /uniform_bucket_level_access\s*=\s*true/);
  assert.match(bucket, /prevent_destroy\s*=\s*true/);
  assert.doesNotMatch(src, /allUsers|allAuthenticatedUsers/, 'nenhum membro público pode aparecer no root');
  assert.doesNotMatch(src, /roles\/storage\.object(Admin|User)\b/, 'objectAdmin/objectUser concedem delete; proibidos');
});

test('DV-001 estático: SA fluxo-debate-worker e job com essa SA, max_retries 0 e ignore_changes da imagem', () => {
  const src = loadRootHcl();
  const sas = ofType(src, 'google_service_account').filter((b) => /account_id\s*=\s*"fluxo-debate-worker"/.test(b.body));
  assert.equal(sas.length, 1, 'esperava google_service_account com account_id = "fluxo-debate-worker"');
  const sa = sas[0].name;
  const jobs = ofType(src, 'google_cloud_run_v2_job').filter((b) => /name\s*=\s*"fluxo-debate-worker"/.test(b.body));
  assert.equal(jobs.length, 1, 'esperava google_cloud_run_v2_job "fluxo-debate-worker"');
  const job = jobs[0].body;
  assert.match(job, new RegExp(`service_account\\s*=\\s*google_service_account\\.${sa}\\.email`), 'job deve rodar com a SA do worker');
  assert.match(job, /max_retries\s*=\s*0\b/);
  assert.match(job, /ignore_changes\s*=\s*\[[^\]]*containers\[0\]\.image[^\]]*\]/, 'ignore_changes deve cobrir a imagem do container');
  assert.doesNotMatch(job, /vpc_access/, 'o worker não usa VPC');
});

test('DV-001 estático: runWithOverrides só no job e nenhum papel run.* no projeto', () => {
  const src = loadRootHcl();
  const all = blocks(src);
  const withRole = all.filter((b) => b.body.includes('roles/run.jobsExecutorWithOverrides'));
  assert.ok(withRole.length >= 1, 'roles/run.jobsExecutorWithOverrides precisa ser concedido à API no job');
  for (const b of withRole) {
    assert.equal(b.type, 'google_cloud_run_v2_job_iam_member', `${b.type}.${b.name} não pode conceder jobsExecutorWithOverrides`);
  }
  for (const b of all.filter((x) => x.type.startsWith('google_project_iam_'))) {
    assert.doesNotMatch(b.body, /roles\/run\./, `${b.type}.${b.name} concede papel run.* no projeto`);
  }
});

test('DV-001 estático: secretAccessor só para o worker e versões de secret numeradas', () => {
  const src = loadRootHcl();
  const sa = ofType(src, 'google_service_account').find((b) => /"fluxo-debate-worker"/.test(b.body))?.name;
  assert.ok(sa, 'SA do worker ausente');
  for (const id of ['SONIOX_API_KEY', 'GOOGLE_FACTCHECK_API_KEY']) {
    assert.ok(ofType(src, 'google_secret_manager_secret').some((b) => b.body.includes(`"${id}"`)), `secret ${id} não declarado`);
  }
  const accessors = blocks(src).filter((b) => b.body.includes('roles/secretmanager.secretAccessor'));
  assert.ok(accessors.length >= 1, 'nenhum binding secretAccessor declarado');
  for (const b of accessors) {
    assert.equal(b.type, 'google_secret_manager_secret_iam_binding', `${b.type}.${b.name}: use binding autoritativo`);
    const members = b.body.match(/members\s*=\s*\[([^\]]*)\]/);
    assert.ok(members, `${b.name}: members ausente`);
    const items = members[1].split(',').map((s) => s.trim()).filter(Boolean);
    assert.equal(items.length, 1, `${b.name}: members deve conter só o worker`);
    assert.match(items[0], new RegExp(`google_service_account\\.${sa}\\.(member|email)`), `${b.name}: membro não é o worker`);
  }
  assert.doesNotMatch(src, /:latest\b|=\s*"latest"/, 'nenhuma referência a latest (versão de secret ou tag de imagem)');
  const refs = src.match(/secret_key_ref\s*\{[^}]*\}/g) ?? [];
  assert.ok(refs.length >= 2, 'job precisa de SONIOX_API_KEY e GOOGLE_FACTCHECK_API_KEY por secret_key_ref');
  for (const r of refs) assert.match(r, /version\s*=\s*var\.\w+/, `versão de secret deve vir de variável numerada: ${r}`);
});

test('DV-001 estático: root não declara rede, Cloud SQL nem serviço Cloud Run da produção', () => {
  const src = loadRootHcl();
  const forbidden = [...blocks(src, 'resource'), ...blocks(src, 'data')]
    .filter((b) => b.type === 'google_compute_network' || b.type.startsWith('google_sql_') || b.type === 'google_cloud_run_v2_service');
  assert.deepEqual(forbidden.map((b) => `${b.type}.${b.name}`), []);
  assert.match(src, /data\s+"google_service_account"\s+"api"/, 'a SA fluxo-api deve ser lida por data, não gerenciada');
});

// ── 2. terraform ─────────────────────────────────────────────────────────────

test('DV-001 terraform: fmt -check e validate do root prod-debates sem backend', () => {
  assert.ok(fs.existsSync(TF_ROOT), 'root prod-debates ausente');
  const which = spawnSync('terraform', ['version'], { encoding: 'utf8' });
  assert.equal(which.error, undefined, 'terraform não está no PATH; o gate não pula');
  const fmt = spawnSync('terraform', [`-chdir=${TF_ROOT}`, 'fmt', '-check', '-recursive'], { encoding: 'utf8' });
  assert.equal(fmt.status, 0, `terraform fmt -check falhou:\n${fmt.stdout}${fmt.stderr}`);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv001-tfdata-'));
  const cache = path.join(os.tmpdir(), 'fluxo-tf-plugin-cache');
  fs.mkdirSync(cache, { recursive: true });
  const env = { ...process.env, TF_DATA_DIR: dataDir, TF_PLUGIN_CACHE_DIR: cache, TF_IN_AUTOMATION: '1' };
  try {
    const init = spawnSync('terraform', [`-chdir=${TF_ROOT}`, 'init', '-backend=false', '-input=false'], { env, encoding: 'utf8', timeout: 90_000 });
    assert.equal(init.status, 0, `terraform init -backend=false falhou:\n${init.stdout}${init.stderr}`);
    const validate = spawnSync('terraform', [`-chdir=${TF_ROOT}`, 'validate'], { env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(validate.status, 0, `terraform validate falhou:\n${validate.stdout}${validate.stderr}`);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ── 3. scripts ───────────────────────────────────────────────────────────────

test('DV-001 scripts: bash -n nos scripts novos (shellcheck quando instalado)', () => {
  for (const script of Object.values(SCRIPTS)) {
    assert.ok(fs.existsSync(script), `script ausente: ${path.relative(ROOT, script)}`);
    const r = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
    assert.equal(r.status, 0, `bash -n falhou em ${path.relative(ROOT, script)}:\n${r.stderr}`);
  }
  const sc = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' });
  if (sc.error) {
    console.warn('Aviso: shellcheck não instalado; somente bash -n foi executado.');
  } else {
    const r = spawnSync('shellcheck', Object.values(SCRIPTS), { encoding: 'utf8' });
    assert.equal(r.status, 0, `shellcheck:\n${r.stdout}${r.stderr}`);
  }
});

// ── 4. deploy do worker ──────────────────────────────────────────────────────

test('DV-001 deploy do worker: recusa tag mutável e imagem de outro projeto ou repositório', () => {
  const rejected = [
    'southamerica-east1-docker.pkg.dev/fluxo-ath/fluxo/fluxo-debate-worker:latest',
    'southamerica-east1-docker.pkg.dev/fluxo-ath/fluxo/fluxo-debate-worker:v1',
    `southamerica-east1-docker.pkg.dev/fluxo-ath-dev/fluxo/fluxo-debate-worker@${DIGEST}`,
    `southamerica-east1-docker.pkg.dev/fluxo-ath/outro/fluxo-debate-worker@${DIGEST}`,
    `southamerica-east1-docker.pkg.dev/fluxo-ath/fluxo/fluxo-jobs@${DIGEST}`,
    `us-docker.pkg.dev/fluxo-ath/fluxo/fluxo-debate-worker@${DIGEST}`,
  ];
  for (const image of rejected) {
    const g = fakeGcloud();
    const r = runScript(SCRIPTS.deployWorker, ['fluxo-ath', 'southamerica-east1', image], g.env());
    assert.notEqual(r.status, 0, `imagem deveria ser recusada: ${image}`);
    assert.deepEqual(g.calls(), [], `nenhuma chamada ao gcloud para imagem recusada: ${image}`);
  }
});

test('DV-001 deploy do worker: digest válido só atualiza a imagem do job', () => {
  const g = fakeGcloud();
  const r = runScript(SCRIPTS.deployWorker, ['fluxo-ath', 'southamerica-east1', WORKER_IMAGE], g.env());
  assert.equal(r.status, 0, `deploy com digest válido falhou:\n${r.output}`);
  const calls = g.calls();
  assert.equal(calls.length, 1, `esperava exatamente uma chamada ao gcloud: ${JSON.stringify(calls)}`);
  const [call] = calls;
  assert.deepEqual(call.slice(0, 4), ['run', 'jobs', 'update', 'fluxo-debate-worker']);
  const flags = call.slice(4);
  assert.ok(flags.includes(`--image=${WORKER_IMAGE}`), `--image=<digest> ausente: ${flags}`);
  assert.ok(flags.includes('--project=fluxo-ath'), '--project=fluxo-ath ausente');
  assert.ok(flags.includes('--region=southamerica-east1'), '--region=southamerica-east1 ausente');
  const allowed = new Set([`--image=${WORKER_IMAGE}`, '--project=fluxo-ath', '--region=southamerica-east1', '--quiet']);
  assert.deepEqual(flags.filter((f) => !allowed.has(f)), [], 'flags além de image/project/region/quiet são do Terraform');
});

// ── 5. config da API ─────────────────────────────────────────────────────────

test('DV-001 config da API: sem --apply não chama gcloud', () => {
  const g = fakeGcloud();
  const r = runScript(SCRIPTS.apiConfig, [], g.env({ PROJECT_ID: 'fluxo-ath', API_OIDC_AUDIENCE: API_URL }));
  assert.equal(r.status, 0, `dry-run falhou:\n${r.output}`);
  assert.deepEqual(g.calls(), [], 'dry-run não pode chamar gcloud');
  assert.match(r.output, /DRY-RUN:.*run.*services.*update.*fluxo-api/, 'dry-run deve imprimir o comando (print_command)');
});

test('DV-001 config da API: --apply usa --update-env-vars, --timeout=3600 e as seis variáveis', () => {
  const g = fakeGcloud();
  const r = runScript(SCRIPTS.apiConfig, ['--apply'], g.env({ PROJECT_ID: 'fluxo-ath', API_OIDC_AUDIENCE: API_URL }));
  assert.equal(r.status, 0, `--apply falhou:\n${r.output}`);
  const calls = g.calls();
  const updates = calls.filter((c) => c.slice(0, 4).join(' ') === 'run services update fluxo-api');
  assert.equal(updates.length, 1, `esperava um único "run services update fluxo-api": ${JSON.stringify(calls)}`);
  assert.ok(calls.every((c) => !c.some((a) => a.startsWith('--set-env-vars'))), '--set-env-vars apagaria as variáveis existentes');
  const [call] = updates;
  assert.ok(call.includes('--timeout=3600'), '--timeout=3600 ausente');
  assert.ok(call.includes('--project=fluxo-ath'), '--project=fluxo-ath ausente');
  const vars = envVarsOf(call);
  for (const expected of [
    'Debates__AudioBucket=fluxo-ath-debates-audio',
    'Debates__WorkerJobName=fluxo-debate-worker',
    'Debates__WorkerJobRegion=southamerica-east1',
    'Debates__ApiServiceAccountEmail=fluxo-api@fluxo-ath.iam.gserviceaccount.com',
    'DebateWorker__ServiceAccountEmail=fluxo-debate-worker@fluxo-ath.iam.gserviceaccount.com',
    `DebateWorker__Audiences__0=${API_URL}`,
  ]) {
    assert.ok(vars.includes(expected), `variável ausente em --update-env-vars: ${expected} (obtido ${vars})`);
  }
});

test('DV-001 config da API: recusa projeto diferente de fluxo-ath', () => {
  for (const project of ['fluxo-ath-dev', 'fluxo-ath-hml']) {
    const g = fakeGcloud();
    const r = runScript(SCRIPTS.apiConfig, ['--apply'], g.env({ PROJECT_ID: project, API_OIDC_AUDIENCE: API_URL }));
    assert.notEqual(r.status, 0, `projeto ${project} deveria ser recusado`);
    assert.deepEqual(g.calls(), [], `nenhuma chamada ao gcloud para ${project}`);
  }
});
