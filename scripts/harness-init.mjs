#!/usr/bin/env node
// Instalador do harness (R4) — semeia o NÚCLEO num repo hospedeiro novo:
//   node scripts/harness-init.mjs <destino> [--nome <projeto>]
// Copia: quality/ (motor, packs, self-tests; SEM .state/reports/baseline e SEM configs de produto),
// hooks e settings dos dois hosts (.claude + .clinerules), rules e agents do núcleo, docs/harness,
// .gitignore, e gera o perfil stub do projeto (quality/profile/<nome>.json) + overlay stub
// (.claude/PROJETO.md). NÃO copia skills de domínio (o overlay é do host) nem scripts de produto
// (deploy/jira/dev). Ao final roda o sync-clinerules do destino e imprime os próximos passos.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOSTS, DEFAULT_HOSTS, parseHosts, carrierFor, resolveHosts } from '../quality/lib/hosts.mjs';

const args = process.argv.slice(2);
let dest = '';
let nome = '';
let hostsSpec = '';
for (let i = 0; i < args.length; i++) {
  const k = args[i];
  if (k === '--nome') { nome = args[++i] ?? ''; continue; }
  if (k === '--hosts') { hostsSpec = args[++i] ?? ''; continue; }
  if (k.startsWith('--')) continue; // flag futura sem valor
  if (!dest) dest = k;
}
if (!dest) {
  console.error(`uso: node scripts/harness-init.mjs <destino> [--nome <projeto>] [--hosts <a,b,all>]
  hosts: ${HOSTS.map((h) => h.id).join(', ')} — default: ${DEFAULT_HOSTS.join(',')}`);
  process.exit(1);
}
const hostParsed = parseHosts(hostsSpec);
if (hostParsed.erros.length) { for (const e of hostParsed.erros) console.error('✗ ' + e); process.exit(1); }
if (!nome) nome = path.basename(path.resolve(dest));

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DST = path.resolve(dest);
fs.mkdirSync(DST, { recursive: true });
// Hosts RESOLVIDOS contra o destino: um quality/hosts.json pré-existente no hospedeiro
// (re-init) sobrescreve paths de estruturas proprietárias sem tocar o núcleo.
const RESOLVED = resolveHosts(DST).hosts;
console.log(`hosts: ${hostParsed.ids.join(', ')}`);

// Base SEMPRE (núcleo host-agnóstico + conteúdo: regras/agents são material de leitura em qualquer host).
const BASE_DIRS = [
  'quality/lib', 'quality/hooks', 'quality/agents', 'quality/delivery', 'quality/packs',
  'quality/test', 'quality/version', 'quality/tools', 'quality/config',
  'scripts/tracker', 'scripts/dev',
  '.claude/rules', '.claude/agents', '.claude/skills', 'docs/harness',
];
const BASE_FILES = [
  'quality/run.mjs', 'quality/baseline.mjs', 'quality/messages.pt-BR.json',
  'quality/tools/biome.json', 'quality/tools/package.json', 'quality/tools/package-lock.json',
  'AGENTS.md', '.gitignore',
];
// Integrações POR HOST ficam no registro (quality/lib/hosts.mjs) e podem ser sobrescritas
// pelo hospedeiro em quality/hosts.json (resolveHosts).

for (const rel of BASE_DIRS) {
  const from = path.join(SRC, rel);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(DST, rel), { recursive: true });
}
for (const rel of BASE_FILES) {
  const from = path.join(SRC, rel);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(DST, rel));
}

for (const id of hostParsed.ids) {
  const host = RESOLVED.find((h) => h.id === id);
  for (const rel of host.integration) {
    const from = path.join(SRC, rel);
    const to = path.join(DST, rel);
    if (rel.endsWith('/')) {
      if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true });
      else { console.error(`✗ integração ausente no núcleo: ${rel}`); process.exitCode = 1; }
    } else if (fs.existsSync(from)) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to);
    } else {
      console.error(`✗ integração ausente no núcleo: ${rel}`);
      process.exitCode = 1;
    }
  }
  const carrier = carrierFor(host, nome);
  if (carrier) {
    fs.mkdirSync(path.join(DST, carrier.dir), { recursive: true });
    fs.writeFileSync(path.join(DST, carrier.relPath), carrier.content);
  }
  console.log(`✓ host ${host.nome} (${id}) — ${host.nota}`);
}

// Configs que eram do perfil legado do Fluxo: um host novo começa SEM elas (o perfil manda).
for (const legado of ['layers.json', 'risk-matrix.json', 'plan-baseline-routes.json', 'plan-gated-routes.json']) {
  fs.rmSync(path.join(DST, 'quality', 'config', legado), { force: true });
}

// Perfil stub do projeto + overlay stub:
const perfil = {
  schemaVersion: 1,
  name: nome,
  locale: 'pt-BR',
  packs: ['pii-br'],
  prompt: { overlay: '.claude/PROJETO.md', domainSkills: [], domainRules: [] },
  tracker: { provider: 'none' },
};
fs.mkdirSync(path.join(DST, 'quality', 'profile'), { recursive: true });
fs.writeFileSync(path.join(DST, 'quality', 'profile', `${nome}.json`), `${JSON.stringify(perfil, null, 2)}\n`);
fs.mkdirSync(path.join(DST, '.claude'), { recursive: true });
fs.writeFileSync(path.join(DST, '.claude', 'PROJETO.md'), `# PROJETO — ${nome}\n\n> Overlay do projeto (fonte viva). Descreva aqui missão, domínios e restrições.\n\n## Missão\n\nTODO\n\n## Restrições\n\nTODO\n`);

// Sync do destino: gera .clinerules/80 (índice) e 85 (overlay), sem drift.
const sync = spawnSync(process.execPath, [path.join(DST, 'quality', 'agents', 'sync-clinerules.mjs')], { cwd: DST, encoding: 'utf8' });

console.log(`✓ harness semeado em ${DST} (perfil: quality/profile/${nome}.json)`);
console.log(`✓ sync-clinerules: ${sync.status === 0 ? 'em sincronia' : `falhou (exit ${sync.status})`}`);
console.log('Próximos passos:');
console.log('  1. cd ' + DST + ' && (git init, se ainda não for um repo)');
console.log('  2. cd quality/tools && npm ci        # Biome para o lint do autofix');
console.log('  3. SKILL onboarding-assessment: leitura do repo + entrevista + documentos → gera o PLANO-ADAPTACAO (adaptar o harness ao projeto)');
console.log('  4. Execute o plano aprovado: perfil (camadas, runners, fronteiras), skills de domínio, tracker/gitflow');
console.log('  5. Edite quality/profile/' + nome + '.json e .claude/PROJETO.md conforme o plano; sync + testes');
