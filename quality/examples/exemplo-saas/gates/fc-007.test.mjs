// Gates FC-007 — infra do worker: Dockerfile multi-stage com memória limitada, manifests Kustomize e render.yaml.
// ANTES da implementação cada gate DEVE falhar: nenhum dos arquivos existe.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-11-14-fluxo-creator FC-007 --baseline
// Estáticos e offline (padrão dos gates de infra; kubeconform entra com o CI do FC-008).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exists, read } from './fc-gate-helper.mjs';

const DOCKERFILE = 'services/creator-worker/Dockerfile';
const K8S = 'infra/k8s/creator';

test('FC-007 docker: Dockerfile multi-stage node:22 com heap 384 MB, USER node e contexto raiz enxuto', () => {
  assert.ok(exists(DOCKERFILE), 'services/creator-worker/Dockerfile ausente');
  const df = read(DOCKERFILE);
  assert.match(df, /# syntax=docker\/dockerfile:1\.7/, 'syntax 1.7 ausente');
  const stages = df.match(/FROM node:22-bookworm-slim/g) ?? [];
  assert.ok(stages.length >= 3, `esperava 3 stages node:22-bookworm-slim (deps/build/runtime), achei ${stages.length}`);
  assert.match(df, /npm ci --omit=dev/, 'deps sem npm ci --omit=dev');
  assert.match(df, /npm ci(?!\s+--omit=dev)/, 'build sem npm ci completo (esbuild é devDependency)');
  assert.match(df, /npm run build/, 'build sem npm run build');
  assert.match(df, /COPY --from=deps \/app\/services\/creator-worker\/node_modules/, 'runtime sem node_modules do deps (o deps instala no workdir do pacote por causa do file: dependency)');
  assert.match(df, /COPY --from=build \/app\/dist/, 'runtime sem dist do build');
  assert.match(df, /NODE_OPTIONS="--max-old-space-size=384"/, 'heap do V8 (384 MB) não fixado');
  assert.match(df, /UV_THREADPOOL_SIZE=2/, 'UV_THREADPOOL_SIZE ausente');
  assert.match(df, /NODE_ENV=production/, 'NODE_ENV ausente');
  assert.match(df, /USER node/, 'runtime roda como root (precisa USER node)');
  assert.match(df, /CMD \["node", "dist\/index\.cjs"\]/, 'CMD deve rodar node dist/index.cjs (npm start do package)');
  // Contexto raiz: os aliases do esbuild precisam destes arquivos dentro do contexto.
  for (const aliased of ['packages/creator-render/src/index.ts', 'ofluxo_site/src/platform/domain/creator-fact-sheet.ts',
    'ofluxo_site/src/platform/domain/civic-context.ts'])
    assert.ok(exists(aliased), `fonte aliased ausente no repo: ${aliased}`);
  assert.ok(exists('.dockerignore'), '.dockerignore da raiz ausente (contexto mandaria o repo inteiro)');
  const ignore = read('.dockerignore');
  assert.match(ignore, /\*/, 'dockerignore sem exclusão geral (*');
  assert.match(ignore, /!services\/creator-worker/, 'dockerignore sem re-inclusão do worker');
  assert.match(ignore, /!packages\/creator-render/, 'dockerignore sem re-inclusão do creator-render');
  assert.match(ignore, /!ofluxo_site\/src\/platform\/domain/, 'dockerignore sem re-inclusão do domain');
  assert.match(ignore, /\*\*\/node_modules/, 'dockerignore sem re-exclusão de node_modules');
});

test('FC-007 k8s: deployment creator-worker com 512Mi/1000m, secret para o banco e overlays render-parity/gke', () => {
  assert.ok(exists(`${K8S}/base/kustomization.yaml`), 'base/kustomization.yaml ausente');
  const kustom = read(`${K8S}/base/kustomization.yaml`);
  assert.match(kustom, /apiVersion: kustomize\.config\.k8s\.io\/v1beta1/, 'kustomization sem apiVersion');
  assert.match(kustom, /kind: Kustomization/, 'kustomization sem kind');
  assert.match(kustom, /deployment\.yaml/, 'kustomization não lista deployment.yaml');
  assert.ok(exists(`${K8S}/base/deployment.yaml`), 'base/deployment.yaml ausente');
  const deploy = read(`${K8S}/base/deployment.yaml`);
  assert.match(deploy, /kind: Deployment/, 'manifest sem Deployment');
  assert.match(deploy, /name: creator-worker/, 'deployment sem name creator-worker');
  assert.match(deploy, /512Mi/, 'limit de memória 512Mi ausente (orçamento do §5.2)');
  assert.match(deploy, /1000m/, 'limit de cpu 1000m ausente');
  assert.match(deploy, /256Mi/, 'request de memória 256Mi ausente');
  assert.match(deploy, /250m/, 'request de cpu 250m ausente');
  assert.match(deploy, /CREATOR_DATABASE_URL/, 'env do banco ausente');
  assert.match(deploy, /secretKeyRef/, 'CREATOR_DATABASE_URL deve vir de secretKeyRef');
  assert.match(deploy, /creator-worker-secrets/, 'secret creator-worker-secrets não citado');
  assert.match(deploy, /--max-old-space-size=384/, 'NODE_OPTIONS do heap ausente');
  assert.match(deploy, /UV_THREADPOOL_SIZE/, 'UV_THREADPOOL_SIZE ausente');
  assert.match(deploy, /CREATOR_RENDER_CONCURRENCY/, 'CREATOR_RENDER_CONCURRENCY ausente');
  for (const overlay of ['render-parity', 'gke']) {
    const path = `${K8S}/overlays/${overlay}/kustomization.yaml`;
    assert.ok(exists(path), `overlay ${overlay} ausente`);
    assert.match(read(path), /\.\.\/\.\.\/base/, `overlay ${overlay} não aponta para ../../base`);
  }
});

test('FC-007 render+compose: worker no Render por imagem ghcr, plan starter, e limite de memória no compose local', () => {
  assert.ok(exists('render.yaml'), 'render.yaml da raiz ausente');
  const render = read('render.yaml');
  assert.match(render, /type: worker/, 'serviço worker ausente no render.yaml');
  assert.match(render, /name: fluxo-creator-worker/, 'serviço fluxo-creator-worker ausente');
  assert.match(render, /runtime: image/, 'runtime image ausente (o Render NÃO constrói: puxa a imagem do CI)');
  assert.match(render, /ghcr\.io/, 'imagem deve vir do ghcr.io');
  assert.match(render, /plan: starter/, 'plan starter ausente (512 MB)');
  assert.match(render, /NODE_OPTIONS/, 'NODE_OPTIONS ausente');
  assert.match(render, /--max-old-space-size=384/, 'heap 384 não fixado no render');
  assert.match(render, /CREATOR_RENDER_CONCURRENCY/, 'CREATOR_RENDER_CONCURRENCY ausente');
  assert.match(render, /fromGroup: fluxo-creator-secrets/, 'grupo de secrets do Doppler ausente');
  const compose = read('backend/deploy/docker-compose.creator-local.yml');
  assert.match(compose, /worker:/, 'compose local sem serviço worker');
  assert.match(compose, /mem_limit:\s*512m/, 'compose sem mem_limit 512m (§5.2: reproduzir produção)');
  assert.match(compose, /cpus:\s*"1\.0"/, 'compose sem cpus 1.0');
  assert.match(compose, /CREATOR_DATABASE_URL/, 'compose worker sem CREATOR_DATABASE_URL');
  assert.match(compose, /services\/creator-worker\/Dockerfile/, 'compose não aponta para o Dockerfile do worker');
});
