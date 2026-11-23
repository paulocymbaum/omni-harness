#!/usr/bin/env node
// Varre arquivos de teste em busca de padrões de force-pass por IA:
//   - assert tautológicos (assert.ok(true), assert.equal(1,1))
//   - blocos de teste vazios (test(..., () => {}))
//   - skip incondicional (test.skip, it.skip)
//   - comando de gate que é no-op (node -e '' ou node --version como único gate)
//   - import sem uso (arquivo importado mas nenhuma função chamada)
//
// Uso:  node quality/delivery/validate-testes.mjs [<glob>...]
// Ex:   node quality/delivery/validate-testes.mjs quality/test/delivery/*.test.mjs
//       node quality/delivery/validate-testes.mjs  (usa o padrão quality/test/**/*.test.mjs)
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { globSync } from 'node:fs'; // Node 22+

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── padrões suspeitos ─────────────────────────────────────────────────────────

const PATTERNS = [
  {
    id: 'assert-tautologico',
    re: /assert\.(ok|isOk|isTrue)\(\s*(true|1|!false)\s*\)/g,
    msg: 'assert tautológico — sempre passa independente da implementação',
  },
  {
    id: 'assert-igual-literal',
    re: /assert\.(equal|strictEqual|deepEqual)\(\s*(\d+)\s*,\s*\2\s*\)/g,
    msg: 'assert com literais iguais (assert.equal(1,1)) — gate no-op',
  },
  {
    id: 'teste-vazio',
    re: /\btest\s*\([^)]+,\s*(?:async\s*)?\(\s*\)\s*=>\s*\{\s*\}\s*\)/g,
    msg: 'bloco de teste vazio — sem asserções',
  },
  {
    id: 'skip-incondicional',
    re: /\btest\.(skip|todo)\s*\(/g,
    msg: 'test.skip / test.todo incondicional — gate nunca executa',
  },
  // gate-noop-node-version: só relevante em backlog.json; em .test.mjs é fixture válida
  // aplicado separadamente em checkBacklogGates()

];

// ── execução ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const files = resolveFiles(args.length ? args : ['quality/test/**/*.test.mjs']);

if (!files.length) {
  console.log('Nenhum arquivo de teste encontrado.');
  process.exit(0);
}

const findings = [];
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  for (const p of PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags);
    let m;
    while ((m = re.exec(src)) !== null) {
      const line = src.slice(0, m.index).split('\n').length;
      findings.push({ file: rel, line, id: p.id, msg: p.msg, match: m[0].slice(0, 60) });
    }
  }
}
// verifica gates no-op em backlog.json (node --version como único gate de uma tarefa)
findings.push(...checkBacklogGates(files));

if (!findings.length) {
  console.log(`✓ ${files.length} arquivo(s) — nenhum padrão de force-pass encontrado.`);
  process.exit(0);
}

console.error(`Force-pass detectado em ${files.length} arquivo(s):\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line} [${f.id}]`);
  console.error(`    ${f.msg}`);
  console.error(`    → ${f.match}`);
}
process.exit(1);

// ── helpers ───────────────────────────────────────────────────────────────────

function resolveFiles(patterns) {
  const found = new Set();
  for (const p of patterns) {
    if (fs.existsSync(path.resolve(ROOT, p)) && !p.includes('*')) {
      found.add(path.resolve(ROOT, p));
      continue;
    }
    try {
      for (const f of globSync(p, { cwd: ROOT, absolute: true })) found.add(f);
    } catch {
      // Node 22 globSync may not be available in older versions
      const dir = path.resolve(ROOT, path.dirname(p.replace(/\*.*$/, '')));
      if (fs.existsSync(dir)) {
        collectMjs(dir, found);
      }
    }
  }
  return [...found];
}

function collectMjs(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectMjs(full, out);
    else if (entry.name.endsWith('.test.mjs')) out.add(full);
  }
}

/** Verifica backlog.json procurando gates cuja única finalidade é `node --version` */
function checkBacklogGates(testFiles) {
  const findings = [];
  // procura backlog.json nas pastas pai dos arquivos de teste
  const dirs = new Set(testFiles.map((f) => {
    // sobe até encontrar backlog.json
    let d = path.dirname(f);
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(d, 'backlog.json');
      if (fs.existsSync(candidate)) return candidate;
      d = path.dirname(d);
    }
    return null;
  }).filter(Boolean));

  // também procura no diretório de entregas
  const deliveryDir = path.join(ROOT, 'docs', 'entregas');
  if (fs.existsSync(deliveryDir)) {
    for (const slug of fs.readdirSync(deliveryDir)) {
      const p = path.join(deliveryDir, slug, 'backlog.json');
      if (fs.existsSync(p)) dirs.add(p);
    }
  }

  for (const backlogPath of dirs) {
    let backlog;
    try { backlog = JSON.parse(fs.readFileSync(backlogPath, 'utf8')); } catch { continue; }
    const rel = path.relative(ROOT, backlogPath);
    for (const gate of backlog.gates ?? []) {
      if (gate.type !== 'command') continue;
      const cmd = gate.command ?? [];
      const isNoop = cmd.length === 2 && cmd[0] === 'node' && cmd[1] === '--version';
      if (isNoop) {
        findings.push({
          file: rel, line: 0, id: 'gate-noop-node-version',
          msg: `gate ${gate.id} usa 'node --version' — não verifica a implementação`,
          match: JSON.stringify(cmd),
        });
      }
    }
  }
  return findings;
}
