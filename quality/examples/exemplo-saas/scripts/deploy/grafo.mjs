// Grafo de deploy da release (epic Exemplo SaaS Creators): definição declarativa dos passos,
// ordem topológica determinística, plano legível e diagrama Mermaid para ver tudo que roda.
// Puro — sem I/O. O CLI (scripts/deploy/release.mjs) consulta o gh e executa na ordem.
//
// Exemplo SaaS: push na RELEASE dispara tudo; passos com `gate` exigem ação humana antes
// (ex.: secrets do Environment prod); `homologar --deploy` só roda com TODOS os
// deploys verdes (Production → Done).

export const STEPS = [
  {
    id: 'validacao',
    titulo: 'Gates de qualidade (motor) — reprovado aqui BLOQUEIA bump e deploy',
    deps: [],
    executar: { tipo: 'cli', cmd: 'node quality/run.mjs --tier completo' },
  },
  {
    id: 'versionar',
    titulo: 'Bump de versão + push RELEASE/tags (publica baseline e dispara as esteiras)',
    deps: ['validacao'],
    // Bump em release/x.y.z (nunca commit direto na RELEASE) + PR/merge em RELEASE, main e develop; roda o gate completo antes.
    executar: { tipo: 'cli', cmd: 'node scripts/deploy/local/release-bump.mjs --main' },
    local: {
      cmd: 'node scripts/deploy/local/release-bump.mjs --main',
      requer: 'gh autenticado (repo) e o gate completo aprovado (FIRESTORE_EMULATOR_HOST para os testes de backend)',
    },
  },
  {
    id: 'seguranca',
    titulo: 'Repository Security Guard (scrub de segredos)',
    workflow: 'Repository Security Guard', workflowPath: 'repository-security.yml',
    deps: ['versionar'],
    monitor: true,
    rerunId: 43802526542,
  },
  {
    id: 'main-merge',
    titulo: 'Release Tag — bump, tags, GitHub Releases e merge RELEASE → main',
    workflow: 'Release Tag (RELEASE)', workflowPath: 'release-tag.yml',
    deps: ['seguranca'],
    monitor: true,
    rerunId: 43802526630,
    // Sem Actions: o mesmo script faz o bump (se pendente) e propaga a release para a main (retoma se já publicada).
    local: {
      cmd: 'node scripts/deploy/local/release-bump.mjs --main',
      requer: 'gh autenticado (repo) e o gate completo aprovado',
    },
  },
  {
    id: 'deploy-api',
    titulo: 'Deploy da API (Cloud Run) — com o fix do carrossel',
    workflow: 'Backend Deploy (Cloud Run)', workflowPath: 'backend-deploy.yml',
    deps: ['main-merge'],
    monitor: true,
    local: {
      cmd: 'bash scripts/deploy/local/deploy-api.sh',
      requer: 'gcloud auth login + application-default login e doppler com prd (sync-secrets)',
    },
  },
  {
    id: 'deploy-worker',
    titulo: 'Deploy do worker — imagem no GHCR (ghcr.io/amoreirat)',
    workflow: 'Creator Worker Deploy (GHCR)', workflowPath: 'creator-worker-deploy.yml',
    deps: ['main-merge'],
    monitor: true,
    rerunId: 43802526527,
    local: {
      cmd: 'gcloud auth configure-docker southamerica-east1-docker.pkg.dev --quiet && docker buildx build --push --file services/creator-worker/Dockerfile --tag southamerica-east1-docker.pkg.dev/fluxo-ath/fluxo/fluxo-creator-worker:sha-$(git rev-parse --short HEAD) --tag southamerica-east1-docker.pkg.dev/fluxo-ath/fluxo/fluxo-creator-worker:latest .',
      requer: 'gcloud autenticado (login feito). ghcr bloqueado por billing GitHub (create_package DENIED) — imagem vai ao Artifact Registry do projeto da API.',
    },
  },
  {
    id: 'deploy-web',
    titulo: 'Deploy do site (RELEASE)',
    workflow: 'Exemplo SaaS Web Deploy (RELEASE)', workflowPath: 'fluxo-web-deploy.yml',
    deps: ['deploy-api'],
    monitor: true,
    local: {
      cmd: 'bash scripts/deploy/local/deploy-web.sh',
      requer: 'doppler CLI logado (fallback extrai os VITE_* públicos do bundle publicado) + FB_DEPLOY_KEY (json de service account com roles/firebasehosting.admin) ou GOOGLE_APPLICATION_CREDENTIALS',
    },
    gate: {
      titulo: 'Secrets VITE_FIREBASE_API_KEY, VITE_FIREBASE_APP_ID e VITE_MAPBOX_TOKEN no Environment prod',
      comandos: [
        'gh secret set VITE_FIREBASE_API_KEY --env prod --body "<valor do Doppler>"',
        'gh secret set VITE_FIREBASE_APP_ID --env prod --body "<valor do Doppler>"',
        'gh secret set VITE_MAPBOX_TOKEN --env prod --body "<valor do Doppler>"',
      ],
    },
    executar: { tipo: 'gh-dispatch', workflow: 'fluxo-web-deploy.yml', ref: 'RELEASE' },
  },
  {
    id: 'deploy-admin',
    titulo: 'Deploy do Admin (RELEASE)',
    workflow: 'Exemplo SaaS Admin Deploy (RELEASE)', workflowPath: 'fluxo-admin-deploy.yml',
    deps: ['deploy-web'],
    monitor: true,
    local: {
      cmd: 'VITE_APP_VERSION=$(node quality/version/bump.mjs --next admin-web --tagged-only) doppler run --project ofluxo --config prd -- npm run build --prefix admin-web && npx --yes firebase-tools@15 deploy --only hosting:admin --project fluxo-ath --non-interactive',
      requer: 'doppler prd com os VITE_* do admin + firebase login (npm ci --prefix admin-web antes)',
    },
  },
  {
    id: 'mobile',
    titulo: 'Builds mobile (opcional)',
    workflow: 'Mobile Builds', workflowPath: 'mobile-builds.yml',
    deps: ['deploy-admin'],
    opcional: true,
    executar: { tipo: 'gh-dispatch', workflow: 'mobile-builds.yml', ref: 'RELEASE' },
  },
  {
    id: 'jira-done',
    titulo: 'Jira: Production → Done (homologar --deploy)',
    deps: ['deploy-worker', 'deploy-web', 'deploy-admin', 'mobile'],
    executar: {
      tipo: 'cli',
      cmd: 'node quality/delivery/backlog.mjs homologar docs/entregas/2026-11-14-fluxo-creator --deploy',
    },
  },
  {
    id: 'verificar',
    titulo: 'Verificação pós-deploy: tags em main, versions.json e health da API',
    deps: ['jira-done'],
  },
];

/** Passos já concluídos (evidência da sessão de homologação/deploy local). */
export const FEITOS = [
  {
    id: 'jira-done',
    titulo: 'Jira: Production → Done (homologar --deploy) — épico + 14 cards (CS-001..015)',
    feitoEm: '2026-11-21 (deploy-web site@v0.2.3 + deploy-worker locais; API /health/ready 200)',
  },
  {
    id: 'verificar',
    titulo: 'Verificação pós-deploy — versions.json web 0.2.3 em produção + API /health/ready 200',
    feitoEm: '2026-11-21',
  },
  {
    id: 'validacao',
    titulo: 'Gates de qualidade (motor) — tier completo verde na RELEASE (nenhum delta a avaliar; deltas gateados por commit no fix/creator-tamanho-imagem-render)',
    feitoEm: '2026-11-21 (quality/run.mjs --tier completo com FIRESTORE_EMULATOR_HOST local)',
  },
  {
    id: 'jira-production',
    titulo: 'Jira: épico + 19 cards em Production (homologação APROVADA)',
    feitoEm: '2026-11-16 (smoketest API PASS + homologar --aprovar)',
  },
  {
    id: 'seguranca',
    titulo: 'Repository Security Guard — guard local OK + scrub de credenciais commitado',
    feitoEm: '2026-11-16 (check-sensitive-files.sh GUARD_OK; commits def7e2b5/scrub)',
  },
  {
    id: 'main-merge',
    titulo: 'Release Tag local — tags baseline publicadas + reconcile origin/main + RELEASE→main',
    feitoEm: '2026-11-16 (main/RELEASE/develop em 631408ed; conflito backend-deploy.yml resolvido pela RELEASE)',
  },
  {
    id: 'deploy-api',
    titulo: 'Deploy da API com o fix do carrossel (FC-013) — replicação local do backend-deploy.yml',
    feitoEm: '2026-11-16 (deploy-api.sh: revisão fluxo-api-00124-tas, imagem a4cfbb12@sha256:27e94707, smoke /health/ready PASS)',
  },
  {
    id: 'deploy-web',
    titulo: 'Deploy do site com o menu Creator (deploy local via SA — o Actions segue sem minutos)',
    feitoEm: '2026-11-16 (deploy-web.sh: fallback do bundle publicado para os VITE_FIREBASE_*, build 0.0.1, hosting ofluxo release + smoke PASS)',
  },
  {
    id: 'deploy-worker',
    titulo: 'Worker no GCP — imagem no Artifact Registry + Cloud Run Job fluxo-creator-worker + Scheduler */5',
    feitoEm: '2026-11-16 (digest sha256:b87af13c com dados do Pulso; VPC fluxo-vpc, Cloud SQL interno, secret creator_database_url; execução validada conectada ao PG. slide_copy pende de CREATOR__LLM_* no Doppler prd)',
  },
];

/** Ordem topológica (Kahn) — determinística: empates saem na ordem de definição. */
export function topoOrdem(steps = STEPS) {
  const porId = new Map(steps.map((s) => [s.id, s]));
  const feitos = new Set();
  const ordem = [];
  let restantes = steps.map((s) => s.id);
  while (restantes.length) {
    const prontos = restantes.filter((id) =>
      porId.get(id).deps.every((d) => feitos.has(d)),
    );
    if (!prontos.length) throw new Error(`ciclo ou dependência desconhecida em: ${restantes.join(', ')}`);
    for (const id of prontos) {
      feitos.add(id);
      ordem.push(porId.get(id));
    }
    restantes = restantes.filter((id) => !feitos.has(id));
  }
  return ordem;
}

/** Diagrama Mermaid do deploy (colar em docs/README para ver tudo que roda). */
export function mermaid(steps = STEPS, feito = FEITOS) {
  const aspas = (t) => t.replace(/"/g, "'");
  const linhas = ['flowchart TD'];
  linhas.push('  push(["push na RELEASE"]) --> seguranca');
  for (const s of topoOrdem(steps)) {
    if (s.id === 'seguranca') continue;
    const classe = s.opcional ? ':::opcional' : '';
    linhas.push(`  ${s.id}["${aspas(s.titulo)}"${classe}]`);
    for (const d of s.deps) linhas.push(`  ${d} --> ${s.id}`);
  }
  const ids = new Set(steps.map((s) => s.id));
  for (const f of feito) {
    linhas.push(`  ${f.id}(["✓ ${aspas(f.titulo)}"])`);
    if (ids.has('release-tag')) linhas.push('  release-tag -.-> jira-production');
  }
  linhas.push('  classDef opcional stroke-dasharray: 4 4;');
  return linhas.join('\n');
}

/** Plano em texto: ordem de execução + status por passo. */
export function planoTexto(steps, statusPorId = {}, feitos = FEITOS) {
  const feitosIds = new Set(feitos.map((f) => f.id));
  return topoOrdem(steps).map((s) => {
    const feito = feitosIds.has(s.id);
    const st = feito ? '✓ feito' : statusPorId[s.id] ?? 'desconhecido';
    const marca = s.opcional ? '(opcional)' : '';
    const gatilho = s.gate && !feito ? ` [GATE HUMANO: ${s.gate.titulo}]` : '';
    return `${s.id.padEnd(12)} ${st.padEnd(10)} ${s.titulo}${marca}${gatilho}`;
  });
}
