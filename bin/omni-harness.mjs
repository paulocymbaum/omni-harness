#!/usr/bin/env node
// CLI do Omni Harness (R-distribuição): o mesmo núcleo, instalável via npm/pnpx, brew ou curl.
//   omni-harness init <destino> [--nome X]   semeia o núcleo num repo hospedeiro (harness-init)
//   omni-harness sync [destino]              sync-clinerules do hospedeiro (default: cwd)
//   omni-harness doctor [destino]            checa node, ferramentas e perfil do hospedeiro
//   omni-harness --version | -v | -h
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveHosts } from '../quality/lib/hosts.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('-')) ?? '';
const flags = argv.filter((a) => a.startsWith('-'));

function help() {
  console.log(`omni-harness — núcleo agnóstico de agentes de código

  omni-harness init <destino> [--nome X] [--hosts a,b,all]   semeia o núcleo num repo hospedeiro
  omni-harness sync [destino]              sync-clinerules do hospedeiro (default: cwd)
  omni-harness doctor [destino]            checa node, ferramentas e perfil do hospedeiro
  omni-harness hosts [destino] [--json]    hosts suportados e paths resolvidos (com overrides)
  omni-harness --version | -v              versão do pacote
  omni-harness -h | --help                 esta ajuda`);
}

function nodeVersionOk() {
  const major = Number(process.versions.node.split('.')[0]);
  return major >= 22 ? true : `node ${process.versions.node} < 22`;
}

function whichOk(cmd) {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 || (r.error && r.error.code !== 'ENOENT');
}

function doctor(dest) {
  const root = path.resolve(dest ?? process.cwd());
  const nodeCheck = nodeVersionOk();
  console.log(`${nodeCheck === true ? '✓' : '✗'} node ${process.versions.node}${nodeCheck === true ? '' : ` — ${nodeCheck} (núcleo exige >= 22)`}`);
  for (const tool of ['git', 'rtk', 'graphify', 'pnpm', 'dotnet', 'flutter', 'uv']) {
    console.log(`${whichOk(tool) ? '✓' : '·'} ${tool}${whichOk(tool) ? '' : ' — ausente (recursos relacionados ficam desligados)'}`);
  }
  const biome = path.join(root, 'quality', 'tools', 'node_modules', '.bin', 'biome');
  console.log(`${fs.existsSync(biome) ? '✓' : '·'} biome (quality/tools: npm ci para ligar o lint do autofix)`);
  const perfil = path.join(root, 'quality', 'profile');
  if (fs.existsSync(perfil)) {
    const perfis = fs.readdirSync(perfil).filter((f) => f.endsWith('.json'));
    console.log(`✓ perfil: ${perfis.join(', ') || 'nenhum (defaults genéricos do núcleo)'}`);
  } else {
    console.log('· perfil: sem quality/profile/ no hospedeiro (defaults genéricos do núcleo)');
  }
  console.log('hosts instalados:');
  for (const host of resolveHosts(root).hosts) {
    const instalado = host.integration.some((rel) => fs.existsSync(path.join(root, rel)));
    const onde = host.carrier ? host.carrier.path : host.integration.join(', ');
    console.log(`${instalado ? '✓' : '·'} ${host.nome} (${host.id}) — ${onde}${instalado ? '' : ' — não instalado (init --hosts)'}`);
  }
  if (nodeCheck !== true) process.exit(1);
}

function main() {
  if (flags.includes('--version') || flags.includes('-v')) {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
    console.log(`${pkg.name} ${pkg.version}`);
    return;
  }
  if (!cmd || flags.includes('-h') || flags.includes('--help')) {
    help();
    return;
  }
  if (cmd === 'init') {
    const dest = argv.filter((a) => a !== cmd && !a.startsWith('--'))[0];
    if (!dest) { console.error('uso: omni-harness init <destino> [--nome X]'); process.exit(1); }
    const rest = argv.filter((a) => a !== cmd);
    const r = spawnSync(process.execPath, [path.join(PKG, 'scripts', 'harness-init.mjs'), ...rest], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
    return;
  }
  if (cmd === 'sync') {
    const dest = path.resolve(argv.filter((a) => a !== cmd && !a.startsWith('-'))[0] ?? process.cwd());
    const script = path.join(dest, 'quality', 'agents', 'sync-clinerules.mjs');
    if (!fs.existsSync(script)) { console.error(`sem ${script} — rode dentro do hospedeiro (ou: omni-harness init <destino>)`); process.exit(1); }
    const r = spawnSync(process.execPath, [script], { cwd: dest, stdio: 'inherit' });
    process.exit(r.status ?? 1);
    return;
  }
  if (cmd === 'hosts') {
    const dest = path.resolve(argv.filter((a) => a !== cmd && !a.startsWith('--') && a !== '--json')[0] ?? process.cwd());
    const asJson = flags.includes('--json');
    const resolved = resolveHosts(dest).hosts;
    if (asJson) { console.log(JSON.stringify(resolved, null, 2)); return; }
    for (const host of resolved) {
      const instalado = host.integration.some((rel) => fs.existsSync(path.join(dest, rel)));
      const onde = host.carrier ? host.carrier.path : host.integration.join(', ');
      console.log(`${instalado ? '✓' : '·'} ${host.id} — ${host.nome}: ${onde}${instalado ? ' [instalado]' : ''}`);
    }
    return;
  }
  if (cmd === 'doctor') {
    doctor(argv.filter((a) => a !== cmd && !a.startsWith('-'))[0]);
    return;
  }
  console.error(`comando desconhecido: ${cmd}`);
  help();
  process.exit(1);
}

main();
