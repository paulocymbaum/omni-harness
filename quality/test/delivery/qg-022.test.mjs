// Gate QG-022 — bloqueador determinístico de Cloud Run Job sempre em voo (eixo de custo).
// Caso-real de referência: creator-worker, timeout 900 s × tick */5 → 3 execuções em voo 24/7
// (entrega 2026-11-22). O E2E usa classifyRisk: em deploy scripts a regra genérica de custo
// (--memory/--cpu) também dispara critico, então os níveis específicos são provados direto no
// jobFlightSignals e no texto dos motivos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRisk, runsPerDay } from '../../../quality/lib/risk.mjs';
import { timeoutMinutes, memoryGi, comandos, jobsFrom, schedulesFrom, jobFlightSignals } from '../../../quality/lib/cost-job.mjs';

const dinheiro = (v) => (v == null ? '' : `; R$ ${Math.round(v)}/mês`);
const CAPTURA = () => {
  const sinais = [];
  return { sinais, raise(level, reason) { sinais.push({ level, reason }); } };
};

const CREATOR = [
  'gcloud run jobs update fluxo-creator-worker --project fluxo-ath --region southamerica-east1 --quiet \\',
  '  --container worker --image southamerica-east1-docker.pkg.dev/fluxo-ath/fluxo/worker@sha256:abc \\',
  '  --task-timeout 900s --cpu 1 --memory 512Mi --parallelism 1 \\',
  '  --set-env-vars CREATOR_IDLE_EXIT_SECONDS=240',
  'gcloud scheduler jobs update fluxo-creator-worker-tick --location southamerica-east1 \\',
  '  --schedule "*/5 * * * *" \\',
  '  --uri "https://run.googleapis.com/v2/projects/fluxo-ath/jobs/fluxo-creator-worker:run"',
];

const PRESENCE = [
  'gcloud run jobs deploy presence-expire --task-timeout 180s --cpu 1 --memory 512Mi --max-retries 1',
  'gcloud scheduler jobs create http presence-tick --schedule "*/5 * * * *" --uri "https://run.googleapis.com/v2/projects/p/jobs/presence-expire:run"',
];

const QUIET = [
  'gcloud run jobs deploy limpeza --task-timeout 60s --cpu 1 --memory 512Mi',
  'gcloud scheduler jobs create http limpeza-tick --schedule "0 * * * *" --uri "https://run.googleapis.com/v2/projects/p/jobs/limpeza:run"',
];

const entrada = (path, linhas) => ({
  path, status: 'M',
  added: linhas.map((text) => ({ text })),
  removed: [],
  newText: linhas.join('\n'),
  oldText: '',
});

test('timeoutMinutes/memoryGi: sufixos do gcloud e garbage', () => {
  assert.equal(timeoutMinutes('900s'), 15);
  assert.equal(timeoutMinutes('15m'), 15);
  assert.equal(timeoutMinutes('1h'), 60);
  assert.equal(timeoutMinutes('1d'), 1440);
  assert.equal(timeoutMinutes('900'), 15);
  assert.equal(timeoutMinutes('rapido'), null);
  assert.equal(memoryGi('512Mi'), 0.5);
  assert.equal(memoryGi('1Gi'), 1);
  assert.equal(memoryGi('2Gi'), 2);
  assert.equal(memoryGi('grande'), null);
});

test('comandos: linhas com \\ de continuação viram um comando só; comentários fora', () => {
  const cmds = comandos([
    'gcloud run jobs update fluxo-a \\',
    '  --task-timeout 900s',
    '# comentário solto',
    'echo fim',
  ]);
  assert.deepEqual(cmds, ['gcloud run jobs update fluxo-a --task-timeout 900s', 'echo fim']);
});

test('creator-worker: timeout 15m × tick */5 → CRÍTICO sempre em voo, 3 execuções, 2160 vCPU-h/mês com preço', () => {
  const cap = CAPTURA();
  jobFlightSignals({ path: 'backend/deploy/jobs/deploy.sh' }, CREATOR, cap, { runsPerDay, money: dinheiro });
  assert.equal(cap.sinais.length, 1);
  assert.equal(cap.sinais[0].level, 'critico');
  assert.match(cap.sinais[0].reason, /SEMPRE EM VOO/);
  assert.match(cap.sinais[0].reason, /3 execu/);
  assert.match(cap.sinais[0].reason, /2\.160 vCPU-h/);
  assert.match(cap.sinais[0].reason, /R\$ 1069\/mês/);
});

test('presence-expire: execução curta (180s < 5min) não é sempre em voo; run-rate alto no teto', () => {
  const cap = CAPTURA();
  jobFlightSignals({ path: 'backend/deploy/jobs/deploy.sh' }, PRESENCE, cap, { runsPerDay, money: dinheiro });
  assert.equal(cap.sinais.length, 1);
  assert.equal(cap.sinais[0].level, 'alto');
  assert.match(cap.sinais[0].reason, /run-rate alto/);
});

test('limpeza: 60s por hora → run-rate abaixo do teto, nenhum sinal', () => {
  const cap = CAPTURA();
  jobFlightSignals({ path: 'backend/deploy/jobs/deploy.sh' }, QUIET, cap, { runsPerDay, money: dinheiro });
  assert.deepEqual(cap.sinais, []);
});

test('job sem agendamento ligado a ele no diff → nenhum sinal', () => {
  const cap = CAPTURA();
  const linhas = ['gcloud run jobs deploy solitario --task-timeout 900s --cpu 4 --memory 1Gi'];
  jobFlightSignals({ path: 'backend/deploy/jobs/x.sh' }, linhas, cap, { runsPerDay, money: dinheiro });
  assert.deepEqual(cap.sinais, []);
});

test('schedule não interpretável → nenhum sinal de voo (cronUnknown fica com o gate de cron)', () => {
  const cap = CAPTURA();
  const linhas = [
    'gcloud run jobs update estranho --task-timeout 900s',
    'gcloud scheduler jobs update estranho-tick --schedule "marcador" --uri "https://run.googleapis.com/v2/projects/p/jobs/estranho:run"',
  ];
  jobFlightSignals({ path: 'x.sh' }, linhas, cap, { runsPerDay, money: dinheiro });
  assert.deepEqual(cap.sinais, []);
});

test('vários schedulers para o mesmo job: prevalece o intervalo MENOR', () => {
  const cmds = [
    'gcloud scheduler jobs update tick-5 --schedule "*/5 * * * *" --job fluxo-x',
    'gcloud scheduler jobs update tick-hora --schedule "0 * * * *" --job fluxo-x',
  ];
  const ag = schedulesFrom(comandos(cmds), runsPerDay);
  assert.equal(ag.get('fluxo-x'), 5);
});

test('E2E classifyRisk: o motivo do job em voo aparece no eixo de custo do diff do creator', () => {
  const risk = classifyRisk([entrada('backend/deploy/jobs/deploy-criador.sh', CREATOR)]);
  assert.equal(risk.level, 'critico');
  assert.ok(risk.cost.reasons.some((r) => /SEMPRE EM VOO/.test(r.text)), JSON.stringify(risk.cost.reasons));
});

test('E2E classifyRisk: presence tem run-rate alto, nunca "sempre em voo"; limpeza não aparece', () => {
  const riskP = classifyRisk([entrada('backend/deploy/jobs/deploy-presence.sh', PRESENCE)]);
  assert.ok(riskP.cost.reasons.some((r) => /run-rate alto/.test(r.text)));
  assert.ok(!riskP.cost.reasons.some((r) => /SEMPRE EM VOO/.test(r.text)));
  const riskQ = classifyRisk([entrada('backend/deploy/jobs/deploy-limpeza.sh', QUIET)]);
  assert.ok(!riskQ.cost.reasons.some((r) => /run-rate alto/.test(r.text)));
  assert.ok(!riskQ.cost.reasons.some((r) => /SEMPRE EM VOO/.test(r.text)));
});

