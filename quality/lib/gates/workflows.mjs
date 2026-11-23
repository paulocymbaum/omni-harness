// G8 (actions-pins): todo `uses:` tocado no diff precisa estar pinado por SHA (40 hex).
// O QG-001 pinou os workflows; com a esteira desligada (GH_ACTIONS=false), este gate local
// impede o drift silencioso de volta para `@v4`. Sem optional chaining neste arquivo.
import { result } from '../report.mjs';

const USES = /^\s*(?:-\s+)?uses:\s*([^\s#]+)/;
const PINADO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/;

export function actionsPinsGate(entries) {
  const out = [];
  for (const e of entries) {
    if (e.status === 'D' || e.newText == null) continue;
    if (!/^\.github\/workflows\/.+\.ya?ml$/.test(e.path)) continue;
    for (const raw of String(e.newText).split('\n')) {
      const m = USES.exec(raw);
      if (m && !PINADO.test(m[1])) {
        out.push(result('actions-pins', 'fail', 'actions.pinsFail', { file: e.path, action: m[1] }));
        if (out.length >= 5) return out;
      }
    }
  }
  return out;
}
