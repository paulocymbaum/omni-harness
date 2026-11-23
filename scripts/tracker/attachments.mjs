// Anexos do épico (imagens do fluxo do usuário). Idempotente: mesmo nome e mesmo tamanho não sobe
// de novo; nome igual com tamanho diferente troca o anexo antigo pelo novo.
import fs from 'node:fs';
import path from 'node:path';

export async function syncAttachments(jira, key, files) {
  if (!files.length) return [];
  const issue = await jira.getIssue(key, 'attachment');
  const existing = issue?.fields?.attachment ?? [];
  const sent = [];
  for (const file of files) {
    const name = path.basename(file);
    const data = fs.readFileSync(file);
    const same = existing.filter((a) => a.filename === name);
    if (same.some((a) => a.size === data.length)) continue;
    for (const old of same) await jira.deleteAttachment(old.id);
    await jira.addAttachment(key, { name, data });
    sent.push(name);
  }
  return sent;
}
