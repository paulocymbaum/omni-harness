#!/usr/bin/env node
// Gera quality/config/plan-baseline-routes.json: toda rota da API no commit a3f4b116, lida de EndpointDataSource. Roda uma vez, na Fase B.
// Exporta o commit para uma pasta temporária, sem tocar a árvore de trabalho. Sem banco, sem Firebase real e sem PSP.
// Uso: node quality/test/delivery/bil-016-baseline-routes.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const COMMIT = 'a3f4b116';
const OUTPUT = path.join(ROOT, 'quality/config/plan-baseline-routes.json');
const COMMAND = 'node quality/test/delivery/bil-016-baseline-routes.mjs';
const TEMPLATES = path.join(ROOT, 'quality/test/delivery/bil-dotnet');

// realpath: no macOS, /var aponta para /private/var, e o MSBuild perde a referência entre projetos com o caminho curto.
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bil-016-routes-')));
try {
  const archive = path.join(work, 'tree.tar');
  execFileSync('git', ['archive', '--format=tar', '-o', archive, COMMIT, 'backend'], { cwd: ROOT });
  execFileSync('tar', ['-xf', archive, '-C', work]);
  const tests = path.join(work, 'backend/tests/Exemplo SaaS.Api.Tests');
  fs.copyFileSync(path.join(TEMPLATES, 'GateBil016RouteDump.cs'), path.join(tests, 'GateBil016RouteDump.cs'));
  const dump = path.join(work, 'routes.txt');
  const run = spawnSync('dotnet', [
    'test', path.join(tests, 'Exemplo SaaS.Api.Tests.csproj'), '--filter', 'FullyQualifiedName~GateBil016RouteDump', '--nologo',
    // Mobility/GtfsStaticFeedTests.cs não compilava nesse commit, sem relação com rotas.
    `-p:CustomAfterMicrosoftCommonTargets=${path.join(TEMPLATES, 'exclude-unrelated-broken-test.targets')}`,
  ], { cwd: work, encoding: 'utf8', env: { ...process.env, BIL_016_ROUTE_DUMP: dump }, maxBuffer: 32 * 1024 * 1024 });
  if (run.status !== 0 || !fs.existsSync(dump)) {
    console.error(`${run.stdout}\n${run.stderr}`.split('\n').slice(-40).join('\n'));
    process.exit(1);
  }
  const routes = fs.readFileSync(dump, 'utf8').split('\n').filter(Boolean);
  const commit = execFileSync('git', ['rev-parse', COMMIT], { cwd: ROOT, encoding: 'utf8' }).trim();
  fs.writeFileSync(OUTPUT, `${JSON.stringify({ commit, source: 'EndpointDataSource', environment: 'Testing', command: COMMAND, routes }, null, 2)}\n`);
  console.log(`${routes.length} rotas de ${commit} em ${path.relative(ROOT, OUTPUT)}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
