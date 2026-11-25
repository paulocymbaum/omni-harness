// QG-022 — bloqueador determinístico de Cloud Run Job sempre em voo (custo).
// Job com task-timeout >= intervalo entre ticks do Scheduler NUNCA termina: fica com execuções
// em voo constantes — um serviço sempre ligado disfarçado de job (caso real do creator-worker,
// entrega 2026-11-22: timeout 900 s × tick */5 = 3 execuções em voo 24/7, ~US$ 390/mês).
// Entrada: comandos ADICIONADOS no diff (deploy/update de job + agendamento que o alveja via
// `--job <nome>` ou `--uri …/jobs/<nome>:run`). Preço de referência: quality/config/cost-table.json;
// teto de run-rate: quality/config/thresholds.json (costJob.maxMonthlyBrl).
// ATENÇÃO: sem `?.` (optional chaining) — o parser do lizard dessincroniza em `?.` e funde funções.

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './util.mjs';
import { t } from './messages.mjs';
import { result } from './report.mjs';

const COSTS = loadConfig('cost-table');
const MAX_MONTHLY_BRL = lerTeto();
const MAX_BUDGET = lerOrcamento();

function lerTeto() {
  const th = loadConfig('thresholds');
  const cfg = th.costJob || {};
  return cfg.maxMonthlyBrl != null ? cfg.maxMonthlyBrl : 200;
}

function lerOrcamento() {
  const th = loadConfig('thresholds');
  const cfg = th.costBudget || {};
  return cfg.maxMonthlyBrl != null ? cfg.maxMonthlyBrl : 400;
}

const money = (value) => (value == null ? '' : `; ≈ R$ ${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(value)}/mês`);

/** task-timeout do gcloud ("900s", "15m", "1h", "900" = segundos) em minutos. null se não parseável. */
export function timeoutMinutes(raw) {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i.exec(String(raw == null ? '' : raw).trim());
  if (!m) return null;
  const fator = { s: 1 / 60, m: 1, h: 60, d: 1440 }[(m[2] || 's').toLowerCase()];
  return Number(m[1]) * fator;
}

/** Memória do gcloud ("512Mi", "1Gi") em GiB. null se não parseável. */
export function memoryGi(raw) {
  const m = /^(\d+)\s*(Mi|Gi)$/i.exec(String(raw == null ? '' : raw).trim());
  if (!m) return null;
  return Number(m[1]) / (m[2].toLowerCase() === 'mi' ? 1024 : 1);
}

const FLAG_CACHE = new Map();

/** Valor de uma flag `--nome` no comando (com ou sem aspas). null se ausente. Regex em cache (perf). */
function flag(cmd, nome) {
  let re = FLAG_CACHE.get(nome);
  if (!re) {
    re = new RegExp(`--${nome}[= ](?:"([^"]*)"|'([^']*)'|([^\\s]+))`);
    FLAG_CACHE.set(nome, re);
  }
  const m = re.exec(cmd);
  if (!m) return null;
  return m[1] != null ? m[1] : m[2] != null ? m[2] : m[3];
}

/** Reconstrói comandos do diff: linhas terminadas em `\` são continuação do comando anterior. */
export function comandos(lines) {
  const out = [];
  let atual = '';
  for (const raw of lines) {
    const line = String(raw == null ? '' : raw).trim();
    if (!line || line.startsWith('#')) continue;
    const continua = /\\$/.test(line);
    const pedaco = line.replace(/\\$/, '').trimEnd();
    atual = atual ? `${atual} ${pedaco}` : pedaco;
    if (!continua) {
      out.push(atual);
      atual = '';
    }
  }
  if (atual) out.push(atual);
  return out;
}

/** Jobs do diff: nome → { timeoutMin, cpu, paralelismo, memoriaGi } (defaults do gcloud quando ausentes). */
export function jobsFrom(comandosDoDiff) {
  const jobs = new Map();
  for (const cmd of comandosDoDiff) {
    for (const m of cmd.matchAll(/gcloud\s+run\s+jobs\s+(?:deploy|update)\s+([\w-]+)([^\n]*)/g)) {
      const mem = memoryGi(flag(m[0], 'memory'));
      const paralel = flag(m[0], 'parallelism') || flag(m[0], 'tasks');
      jobs.set(m[1], {
        timeoutMin: timeoutMinutes(flag(m[0], 'task-timeout')),
        cpu: Number(flag(m[0], 'cpu')) || 1,
        paralelismo: Number(paralel) || 1,
        memoriaGi: mem == null ? 0.5 : mem,
      });
    }
  }
  return jobs;
}

const SCHED_RE = /gcloud\s+scheduler\s+jobs\s+(?:create|update)\s+(?:http\s+)?([\w-]+)([^\n]*)/g;

/** Job alvo de um agendamento: `--job <nome>` ou `--uri …/jobs/<nome>:run`. null se não alveja job. */
function alvoDoScheduler(bloco) {
  const m = /--job[= ]([\w-]+)|\/jobs\/([\w-]+):run/.exec(bloco);
  return m ? m[1] || m[2] : null;
}

/** Intervalo entre execuções (minutos) do `--schedule` do bloco. null se não interpretável. */
function intervaloDoSchedule(bloco, runsPerDay) {
  const schedule = flag(bloco, 'schedule');
  if (!schedule) return null;
  const porDia = runsPerDay(schedule);
  if (porDia == null || porDia <= 0) return null;
  return 1440 / porDia;
}

/** Agendamentos do diff: job alvo → MENOR intervalo em minutos (vários schedulers = pega o mais frequente). */
export function schedulesFrom(comandosDoDiff, runsPerDay) {
  const porJob = new Map();
  for (const cmd of comandosDoDiff) {
    for (const m of cmd.matchAll(SCHED_RE)) {
      const alvo = alvoDoScheduler(m[0]);
      const intervalo = intervaloDoSchedule(m[0], runsPerDay);
      if (!alvo || intervalo == null) continue;
      const atual = porJob.get(alvo);
      if (atual == null || intervalo < atual) porJob.set(alvo, intervalo);
    }
  }
  return porJob;
}

/** Custo mensal estimado (R$) ou null sem a tabela de preços preenchida. */
function custoMensal(vcpuHoraMes, gibHoraMes) {
  const vcpu = COSTS.cloudRunJobVcpuHour;
  const gib = COSTS.cloudRunJobGibHour;
  if (vcpu == null || gib == null) return null;
  return vcpuHoraMes * vcpu + gibHoraMes * gib;
}

/** vCPU-h/mês + R$/mês de UM job no intervalo dado (fração do duty-cycle quando execução curta). */
function custoDoJob(j, intervaloMin) {
  const emVoo = j.timeoutMin >= intervaloMin ? Math.ceil(j.timeoutMin / intervaloMin) : j.timeoutMin / intervaloMin;
  const vcpuHoraMes = emVoo * j.cpu * j.paralelismo * 24 * 30;
  const gibHoraMes = emVoo * j.memoriaGi * j.paralelismo * 24 * 30;
  return { emVooMax: Math.ceil(j.timeoutMin / intervaloMin), sempreEmVoo: j.timeoutMin >= intervaloMin, vcpuHoraMes, mensal: custoMensal(vcpuHoraMes, gibHoraMes) };
}

/** Matemática e mensagem de UM job agendado: sempre em voo → critico; run-rate acima do teto → alto. */
function sinalDoJob(opts) {
  const { e, cost, helpers } = opts;
  const job = opts.job;
  const j = opts.j;
  const intervaloMin = opts.intervaloMin;
  const calc = custoDoJob(j, intervaloMin);
  if (calc.sempreEmVoo) {
    cost.raise('critico', t('cost.jobInFlight', {
      job, timeout: Math.round(j.timeoutMin), intervalo: Math.round(intervaloMin),
      emVoo: calc.emVooMax, cpu: j.cpu, paralelismo: j.paralelismo,
      vcpuHoraMes: Math.round(calc.vcpuHoraMes), money: helpers.money(calc.mensal),
    }), e.path);
    return;
  }
  if (calc.mensal != null && calc.mensal > MAX_MONTHLY_BRL) {
    cost.raise('alto', t('cost.jobRunRate', {
      job, vcpuHoraMes: Math.round(calc.vcpuHoraMes), teto: MAX_MONTHLY_BRL, money: helpers.money(calc.mensal),
    }), e.path);
  }
}

/** Sinais de custo de job agendado no diff (eixo custo). helpers = { runsPerDay, money } vindos do motor. */
export function jobFlightSignals(e, addedText, cost, helpers) {
  const comandosDoDiff = comandos(addedText);
  if (!comandosDoDiff.length) return;
  const jobs = jobsFrom(comandosDoDiff);
  for (const [job, intervaloMin] of schedulesFrom(comandosDoDiff, helpers.runsPerDay)) {
    const j = jobs.get(job);
    if (!j || j.timeoutMin == null) continue;
    sinalDoJob({ e, cost, helpers, job, intervaloMin, j });
  }
}

// ---------------------------------------------------------------- orçamento agregado (QG-022/G3)

/** Blocos Terraform (`resource`/`module`) de um arquivo .tf, um por entrada. */
function blocosTerraform(texto) {
  const blocos = [];
  let atual = null;
  for (const line of String(texto ?? '').split('\n')) {
    if (/^\s*(?:resource|module)\s+"/.test(line)) {
      if (atual != null) blocos.push(atual);
      atual = line;
    } else if (atual != null) {
      atual += '\n' + line;
    }
  }
  if (atual != null) blocos.push(atual);
  return blocos;
}

/** Pares agendamento → job de UM arquivo Terraform: `schedule` + alvo (`uri …/jobs/<nome>:run` ou `name` do módulo). */
export function schedulesTerraform(texto, runsPerDay) {
  const porJob = new Map();
  for (const bloco of blocosTerraform(texto)) {
    const job = alvoDoBlocoTerraform(bloco);
    const schedule = /(?:^|\n)\s*schedule\s*=\s*"([^"]+)"/.exec(bloco);
    if (!job || !schedule) continue;
    const porDia = runsPerDay(schedule[1]);
    if (porDia == null || porDia <= 0) continue;
    const intervalo = 1440 / porDia;
    const atual = porJob.get(job);
    if (atual == null || intervalo < atual) porJob.set(job, intervalo);
  }
  return porJob;
}

/** Alvo de um bloco TF: `uri …/jobs/<nome>:run` ou o próprio `name = "fluxo-<nome>"` do módulo. */
function alvoDoBlocoTerraform(bloco) {
  const uri = /\/jobs\/([\w-]+):run/.exec(bloco);
  if (uri) return uri[1];
  const nome = /(?:^|\n)\s*name\s*=\s*"(fluxo-[\w-]+)"/.exec(bloco);
  return nome ? nome[1] : null;
}

/** Tabela do repo: linhas `deploy_job <nome> <runner> <memória> <timeout>` → job (cpu 1 default). */
export function jobsManifesto(texto) {
  const jobs = new Map();
  for (const line of String(texto ?? '').split('\n')) {
    const m = /^\s*deploy_job\s+([\w-]+)\s+[\w-]+\s+(\S+)\s+(\S+)\s*$/.exec(line);
    if (!m) continue;
    const mem = memoryGi(m[2]);
    jobs.set(m[1], { timeoutMin: timeoutMinutes(m[3]), cpu: 1, paralelismo: 1, memoriaGi: mem == null ? 0.5 : mem });
  }
  return jobs;
}

const DIRS_DE_JOB = ['backend/deploy', 'scripts', 'infra', 'services'];
const PULAR = new Set(['node_modules', '.git', 'dist', 'build', 'graphify-out', '.venv']);

function arquivosDeJob(raiz, dirRel, profundidade, out) {
  if (profundidade > 6) return;
  let entradas = [];
  try { entradas = fs.readdirSync(path.join(raiz, dirRel), { withFileTypes: true }); } catch { return; }
  for (const e of entradas) {
    if (PULAR.has(e.name)) continue;
    const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
    if (e.isDirectory()) arquivosDeJob(raiz, rel, profundidade + 1, out);
    else if (/\.(sh|yaml|yml|tf)$/.test(e.name)) out.push(rel);
  }
}

function lerArquivosDeJob(raiz, dirs) {
  const arquivos = [];
  for (const dir of dirs) arquivosDeJob(raiz, dir, 0, arquivos);
  return arquivos
    .map((rel) => {
      try { return { rel, texto: fs.readFileSync(path.join(raiz, rel), 'utf8') }; } catch { return null; }
    })
    .filter(Boolean);
}

function mapaDeJobs(arquivos) {
  const jobs = new Map();
  for (const { rel, texto } of arquivos) {
    if (!/gcloud run jobs|deploy_job /.test(texto)) continue;
    const cmds = comandos(texto.split('\n'));
    for (const [nome, j] of jobsFrom(cmds)) jobs.set(nome, j);
    for (const [nome, j] of jobsManifesto(texto)) if (!jobs.has(nome)) jobs.set(nome, j);
  }
  return jobs;
}

function mapaDeAgendamentos(arquivos, helpers) {
  const agendamentos = new Map();
  const funde = (job, intervalo) => {
    const atual = agendamentos.get(job);
    if (atual == null || intervalo < atual) agendamentos.set(job, intervalo);
  };
  for (const { rel, texto } of arquivos) {
    const cmds = comandos(texto.split('\n'));
    for (const [job, intervalo] of schedulesFrom(cmds, helpers.runsPerDay)) funde(job, intervalo);
    if (rel.endsWith('.tf')) {
      for (const [job, intervalo] of schedulesTerraform(texto, helpers.runsPerDay)) funde(job, intervalo);
    }
  }
  return agendamentos;
}

function somaOrcamento(jobs, agendamentos) {
  const linhas = [];
  let soma = 0;
  for (const [job, intervaloMin] of agendamentos) {
    const j = jobs.get(job);
    if (!j || j.timeoutMin == null) continue;
    const calc = custoDoJob(j, intervaloMin);
    if (calc.mensal == null) continue;
    soma += calc.mensal;
    linhas.push({ job, mensal: calc.mensal, vcpuHoraMes: calc.vcpuHoraMes });
  }
  linhas.sort((a, b) => b.mensal - a.mensal);
  return { linhas, soma };
}

/** Orçamento agregado (G3): soma R$/mês de TODOS os jobs agendados declarados vs `thresholds.costBudget`. */
export function costBudgetGate(raiz, out, helpers, { dirs = DIRS_DE_JOB } = {}) {
  const arquivos = lerArquivosDeJob(raiz, dirs); // leitura única compartilhada entre jobs e agendamentos (perf)
  const { linhas, soma } = somaOrcamento(mapaDeJobs(arquivos), mapaDeAgendamentos(arquivos, helpers));
  const maior = linhas[0];
  const params = {
    total: Math.round(soma), teto: MAX_BUDGET,
    job: maior ? maior.job : '—',
    vcpuHoraMes: maior ? Math.round(maior.vcpuHoraMes) : 0,
    jobs: linhas.length,
  };
  if (soma > MAX_BUDGET) out.push(result('custo-orcamento', 'fail', 'cost.budgetFail', params));
  else out.push(result('custo-orcamento', 'pass', 'cost.budgetPass', params));
}
