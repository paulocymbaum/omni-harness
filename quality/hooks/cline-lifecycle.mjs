#!/usr/bin/env node
// TaskStart, TaskResume e TaskComplete do Cline (os wrappers em .clinerules/hooks chamam este arquivo com o evento
// em argv[2]). Equivalentes dos hooks do Claude: SessionStart → TaskStart/TaskResume (inventário de ferramentas e aviso do
// grafo); Stop → TaskComplete (gates do nível de risco + lembrete de documentação). No Cline o fim da tarefa não pode ser
// BLOQUEADO (decision:block do Claude): o resultado volta como contexto, com o mesmo texto. Falha aberta; responde `{}`.
import { readStdinJson, repoRoot } from '../lib/util.mjs';
import { SCRIPTS, comCap, readPost, runClaudeHook } from '../lib/cline-bridge.mjs';

const EVENTS = {
  TaskStart: { hook: 'SessionStart', scripts: [SCRIPTS.sessionStart], timeoutMs: 60_000 },
  TaskResume: { hook: 'SessionStart', scripts: [SCRIPTS.sessionStart], timeoutMs: 60_000 },
  TaskComplete: { hook: 'Stop', scripts: [SCRIPTS.stop, SCRIPTS.lembrarDocs], timeoutMs: 110_000 },
};

function runLifecycle(event, input, root) {
  const spec = EVENTS[event];
  if (!spec) return [];
  const sessionId = `cline-${input.taskId ?? input.sessionId ?? 'sem-tarefa'}`;
  return spec.scripts.flatMap((script) => {
    const res = runClaudeHook(script, { hook_event_name: spec.hook }, { root, sessionId, timeoutMs: spec.timeoutMs });
    const linhas = readPost(res);
    if (res.timedOut) {
      linhas.push(
        `hook ${script} não coube no janelão de ${Math.round(spec.timeoutMs / 1000)}s (saída parcial) — rode manualmente antes de encerrar: node quality/run.mjs --tier rotina --json`,
      );
    }
    return linhas;
  });
}

let out = {};
try {
  const input = readStdinJson();
  const root = process.env.QUALITY_ROOT || (typeof input.workspaceRoots?.[0] === 'string' ? input.workspaceRoots[0] : null) || repoRoot();
  const text = comCap(runLifecycle(process.argv[2], input, root).join('\n'));
  if (text) out = { context: text, contextModification: text };
} catch { /* falha aberta */ }
process.stdout.write(JSON.stringify(out));
process.exit(0);
