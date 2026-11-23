// Gates FC-015 — Kubernetes real e autoscaling por fila, pré-implementados e SEM ativação.
// A decisão (docs/entregas/2026-11-14-fluxo-creator/decisao-infra-fc-015.md) fixou: Render 1 réplica
// na produção atual; overlay GKE com KEDA por profundidade da pista render liga só por gatilho de
// métrica/custo. Este gate prova o código do overlay e o runbook de drenagem/rollback.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-11-14-fluxo-creator FC-015
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read } from './fc-gate-helper.mjs';

const GKE = 'infra/k8s/creator/overlays/gke';
const RUNBOOK = 'backend/deploy/creator-worker-autoscaling.md';
const DECISAO = 'docs/entregas/2026-11-14-fluxo-creator/decisao-infra-fc-015.md';
const SPEC = 'docs/entregas/2026-11-14-fluxo-creator/specs/FC-015.md';

test('FC-015 gke: ScaledObject escala pela profundidade da pista render, sem URL literal', () => {
  const so = read(`${GKE}/scaledobject.yaml`);
  assert.match(so, /kind: ScaledObject/, 'ScaledObject ausente');
  assert.match(so, /type: postgresql/, 'scaler não é o da fila Postgres');
  assert.match(
    so,
    /SELECT count\(\*\) FROM creator_jobs WHERE status = 'queued' AND kind = 'render'/,
    'query não é a profundidade da pista render',
  );
  assert.match(so, /minReplicaCount: 1/, 'min de réplicas ausente');
  assert.match(so, /maxReplicaCount: 4/, 'teto de réplicas ausente');
  assert.match(so, /cooldownPeriod: 300/, 'cooldown contra oscilação em lease longo ausente');
  assert.match(so, /connectionFromEnv: CREATOR_DATABASE_URL/, 'conexão não vem do Secret');
  assert.ok(!/postgres(ql)?:\/\//.test(so), 'URL de conexão literal em manifesto');
});

test('FC-015 gke: PDB mantém a fila viva e NetworkPolicy restringe a saída', () => {
  const pdb = read(`${GKE}/pdb.yaml`);
  assert.match(pdb, /kind: PodDisruptionBudget/, 'PDB ausente');
  assert.match(pdb, /minAvailable: 1/, 'PDB sem minAvailable 1');
  assert.match(pdb, /app\.kubernetes\.io\/name: creator-worker/, 'PDB sem o label do base');
  const np = read(`${GKE}/networkpolicy.yaml`);
  assert.match(np, /kind: NetworkPolicy/, 'NetworkPolicy ausente');
  assert.match(np, /policyTypes:[\s\S]*?- Egress/, 'policyTypes sem Egress');
  assert.ok(!/- Ingress/.test(np), 'worker com ingress aberto (é background worker sem porta)');
  assert.match(np, /5432/, 'egress sem a porta do Postgres');
  const kustom = read(`${GKE}/kustomization.yaml`);
  for (const recurso of ['../../base', 'scaledobject.yaml', 'pdb.yaml', 'networkpolicy.yaml']) {
    assert.ok(kustom.includes(recurso), `kustomization sem ${recurso}`);
  }
});

test('FC-015 docs: decisão com gatilhos e runbook com lease/drain/rollback', () => {
  const runbook = read(RUNBOOK);
  assert.match(runbook, /CREATOR_LEASE_SECONDS/, 'runbook sem o tempo de expiração de lease');
  assert.match(runbook, /kubectl apply -k infra\/k8s\/creator\/overlays\/gke/, 'runbook sem o apply do overlay');
  assert.match(runbook, /kubectl delete scaledobject/, 'runbook sem rollback');
  const decisao = read(DECISAO);
  for (const gatilho of ['10 min', '200 jobs', 'DECIDIDA', 'Render']) {
    assert.ok(decisao.includes(gatilho), `decisão sem o gatilho ${gatilho}`);
  }
  assert.match(decisao, /LGPD, art\. 33|art\. 33/, 'decisão sem nota de transferência internacional');
  const spec = read(SPEC);
  assert.match(spec, /Status: ready/, 'spec não destravada');
  assert.match(spec, /decisao-infra-fc-015\.md/, 'spec sem rastro da decisão');
});
