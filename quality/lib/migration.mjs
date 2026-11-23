// Modo migração (--migration-override): para merge completo ou migração completa,
// onde todo o código chega como "novo" em relação à base, os gates de métrica
// incremental (ratchet de diff, teto de função nova, formatação herdada,
// supressões/fronteiras herdadas, cobertura do diff) produzem falso positivo
// estrutural — eles medem piora incremental, não sanidade do código que chega.
// Nesse modo cada gate da lista abaixo é substituído por um resultado IGNORADO
// com o motivo; gates semânticos (tipos, testes, exports, ferramentas) nunca
// são ignorados. Uso explícito e auditável: a evidência registra o modo.
import { result } from './report.mjs';

export const MIGRATION_DEFAULT_REASON = 'merge/migração completa';

/** Gates que não fazem sentido quando o diff é o repositório inteiro. */
export const MIGRATION_IGNORED_GATES = new Set([
  'tamanho', 'tamanho-funcao', 'parametros', 'complexidade',
  'halstead-volume', 'halstead-difficulty', 'formato',
  'supressoes', 'fronteiras', 'fallback-api', 'lint', 'cobertura-diff',
]);

/**
 * Substitui os resultados dos gates incrementais por um IGNORADO por gate,
 * com a contagem do que foi suprimido. Gates semânticos passam intactos.
 */
export function applyMigrationOverride(results, { active, reason } = {}) {
  if (!active) return { results, ignoredGates: [] };
  const motive = reason || MIGRATION_DEFAULT_REASON;
  const suppressed = new Map();
  const kept = [];
  for (const r of results) {
    if (MIGRATION_IGNORED_GATES.has(r.gate)) suppressed.set(r.gate, (suppressed.get(r.gate) ?? 0) + 1);
    else kept.push(r);
  }
  const ignored = [...suppressed.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([gate, count]) => result(gate, 'skip', 'migration.gateIgnored', { count, reason: motive }));
  return { results: [...kept, ...ignored], ignoredGates: [...suppressed.keys()].sort() };
}
