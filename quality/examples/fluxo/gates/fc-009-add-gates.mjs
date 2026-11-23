// Fase B (eval-gate-author): adiciona os gates da FC-009 ao backlog.json. Determinístico e idempotente.
import fs from 'node:fs';

const p = 'docs/entregas/2026-11-14-fluxo-creator/backlog.json';
const b = JSON.parse(fs.readFileSync(p, 'utf8'));
const cmd = (pat) => ['node', '--test', '--test-name-pattern=^FC-009 ' + pat + ':', 'quality/test/delivery/fc-009.test.mjs'];
const g = (id, pat, extra) => Object.assign({ id, task: 'FC-009', type: 'command', command: cmd(pat) }, extra ?? {});
const gates = [
  g('FC-009-CONTRATO', 'contrato'),
  g('FC-009-API', 'api'),
  g('FC-009-PREVIA', 'previa'),
  g('FC-009-ABA', 'aba'),
  g('FC-009-DEV-TOKEN', 'dev-token'),
  g('FC-009-COMPOSE', 'compose'),
  g('FC-009-REGRESSAO', 'regressao', { timeout_ms: 600000 }),
  g('FC-009-DOCS', 'docs'),
];
const have = new Set(b.gates.map((x) => x.id));
let added = 0;
for (const x of gates) if (!have.has(x.id)) { b.gates.push(x); added += 1; }
fs.writeFileSync(p, JSON.stringify(b, null, 2) + '\n');
console.log(`gates adicionados: ${added}; total: ${b.gates.length}`);
