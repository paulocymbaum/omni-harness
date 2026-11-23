#!/usr/bin/env node
// PreToolUse (Bash) do Claude Code: reescreve comandos ruidosos para `rtk <cmd>` (saída
// compacta, até ~90% menos tokens) delegando ao `rtk hook claude`. É um wrapper porque o
// settings.json é versionado: sem o binário `rtk` (ou com RTK_DISABLED=1) não faz nada, e o
// hook do rtk só devolve `updatedInput` (nunca aprova sozinho, então as permissões valem).
// `--version`/`--help` não são reescritos. Em produção quem roda é o despachante
// (pre-bash-dispatch.mjs); este arquivo continua como CLI independente e para os testes.
import fs from 'node:fs';
import { rtkClaudeHook } from '../lib/rtk-rewrite.mjs';

try {
  const out = rtkClaudeHook(fs.readFileSync(0, 'utf8'));
  if (out) process.stdout.write(out);
} catch { /* falha aberta */ }
process.exit(0);
