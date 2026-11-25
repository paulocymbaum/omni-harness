// Gate QG-026 — deploy scripts 100% parametrizados: valor de produção literal só em linha de
// default/atribuição (topo) ou comentário; no corpo do script, só variável. E sintaxe bash válida.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const RAIZ = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIR = join(RAIZ, 'scripts', 'deploy', 'local');
const SCRIPTS = ['deploy-api.sh', 'deploy-web.sh', 'deploy-worker.sh', 'creator-worker-sob-demanda.sh', 'push-creator-llm.sh'];

// Recurso de produção → substrings que não podem aparecer fora de default/atribuição/comentário.
const LITERAIS = {
  'deploy-worker.sh': ['fluxo-creator-worker', 'fluxo-ath-creator-results', 'southamerica-east1', 'creator-results', '/app/var/creator-render', 'services/creator-worker/Dockerfile'],
  'creator-worker-sob-demanda.sh': ['fluxo-creator-worker', 'fluxo-creator-worker-tick', 'fluxo-api'],
  'deploy-api.sh': ['fluxo-api', 'fluxo-migrator', 'fluxo-artist-sync', 'fluxo-billing-reconcile', 'fluxo-civic-action-retention', 'creator-results', '/app/var/creator-render', 'backend/cloudbuild.deploy.yaml'],
  'deploy-web.sh': ['--project ofluxo', 'hosting:ofluxo', 'https://ofluxo.web.app', 'ofluxo_site'],
  'push-creator-llm.sh': ['--project ofluxo', '--config prd', 'fluxo-creator-worker'],
};

const atribuicao = (l) => /^\s*(export\s+)?[A-Z_][A-Z0-9_]*=/.test(l);
const comentario = (l) => /^\s*#/.test(l);

const infracoes = (script, literais) => {
  const achados = [];
  readFileSync(join(DIR, script), 'utf8').split('\n').forEach((l, i) => {
    if (atribuicao(l) || comentario(l)) return;
    for (const literal of literais) {
      if (l.includes(literal)) achados.push(`${script}:${i + 1} contém "${literal}" → ${l.trim().slice(0, 80)}`);
    }
  });
  return achados;
};

for (const script of SCRIPTS) {
  test(`${script}: nenhum valor de produção hardcoded no corpo`, () => {
    const achados = infracoes(script, LITERAIS[script]);
    assert.deepEqual(achados, []);
  });
  test(`${script}: sintaxe bash válida`, () => {
    const r = spawnSync('bash', ['-n', join(DIR, script)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });
}

test('convergência: os scripts do creator compartilham o MESMO parâmetro CREATOR_JOB', () => {
  for (const script of ['deploy-worker.sh', 'creator-worker-sob-demanda.sh', 'push-creator-llm.sh']) {
    const texto = readFileSync(join(DIR, script), 'utf8');
    assert.match(texto, /JOB="\$\{CREATOR_JOB:-fluxo-creator-worker\}"/, `${script} não usa CREATOR_JOB`);
  }
});
