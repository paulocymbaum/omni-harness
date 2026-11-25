// Helper dos gates FC-001. Os templates xUnit (fc-dotnet/) são do autor de gates e só existem no
// projeto de testes durante a execução: nenhum teste do implementador serve como prova do
// contrato. Peças comuns (runDotnetGate, walk, leitura) vivem em dotnet-gate-common.mjs; este
// módulo fixa a família FC (templates fc-dotnet, GateFcSupport, exclusões .dart_tool/build).
import path from 'node:path';
import { makeDotnetGate, existsRel, readFileRel, walkRel } from './dotnet-gate-common.mjs';
import { ROOT, requireEnv } from './dv-002-dotnet-helper.mjs';

export { ROOT, requireEnv };

export const CREATOR_DIR = 'backend/src/Exemplo SaaS.Api/Modules/Creator';
const TEMPLATES = path.join(ROOT, 'quality/test/delivery/fc-dotnet');
const EXCLUDE_TARGETS = path.join(ROOT, 'quality/test/delivery/fc-dotnet/exclude-unrelated-broken-tests.targets');
const SUPPORT = 'GateFcSupport.cs';

export const exists = (rel) => existsRel(ROOT, rel);

export const read = (rel) => readFileRel(ROOT, rel);

export function walk(rel, keep = () => true) {
  return walkRel(ROOT, rel, keep, { exclude: ['bin', 'obj', 'node_modules', '.dart_tool', 'build'] });
}

/** runDotnetGate da família FC: PostgreSQL só quando o gate pede; requiredFiles/byMethod por gate. */
export const runDotnetGate = makeDotnetGate({
  root: ROOT, templatesDir: TEMPLATES, excludeTargets: EXCLUDE_TARGETS, supportFile: SUPPORT, trxPrefix: 'fc',
});

