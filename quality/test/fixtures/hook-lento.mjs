#!/usr/bin/env node
// Fixture do teste de truncamento (cline-truncamento.test.mjs): escreve saída parcial e segura
// o processo além do timeout do chamador — prova que runClaudeHook devolve timedOut + saída parcial.
process.stdout.write('parcial\n');
setTimeout(() => {}, 5_000);
