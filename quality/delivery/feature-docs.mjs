// Documentos de feature que o épico do Jira carrega e que a homologação exige:
//   brd.md            BRD: requisitos, regras de negócio e cenários de aceite (Dado/Quando/Então)
//   fluxo-usuario.md  fluxo do usuário (passos e diagrama mermaid)
//   diagramas/fluxo-usuario*.png  imagem do fluxo (anexada ao épico)
// Mesma convenção das specs: só vale com `Status: ready` e sem dado pessoal (inspectSpec).
import fs from 'node:fs';
import path from 'node:path';
import { inspectSpec } from '../lib/spec-sync.mjs';
import { describeFindings } from '../lib/pii-guard.mjs';

export const BRD_FILE = 'brd.md';
export const FLOW_FILE = 'fluxo-usuario.md';
const FLOW_IMAGE = /^fluxo-usuario.*\.png$/i;

const read = (dir, file) => ({ file, ...inspectSpec(path.join(dir, file)) });

/** Estado dos dois documentos e das imagens do fluxo (caminhos absolutos). */
export function featureDocs(dir) {
  let images = [];
  try { images = fs.readdirSync(path.join(dir, 'diagramas')).filter((f) => FLOW_IMAGE.test(f)).sort().map((f) => path.join(dir, 'diagramas', f)); } catch { /* sem diagramas */ }
  return { brd: read(dir, BRD_FILE), fluxo: read(dir, FLOW_FILE), images };
}

const LABEL = { brd: 'BRD', fluxo: 'fluxo do usuário' };
const STATE_TEXT = { missing: 'ausente', draft: 'em rascunho (falta `Status: ready`)' };

/** Pendências (frases pt-BR) dos documentos; vazio quando os dois estão prontos. */
export function docsProblemas(docs) {
  return ['brd', 'fluxo'].flatMap((k) => {
    const d = docs[k];
    if (d.state === 'ready') return [];
    if (d.state === 'blocked') return [`${LABEL[k]} com dados pessoais (${describeFindings(d.findings)}): ${d.file}`];
    return [`${LABEL[k]} ${STATE_TEXT[d.state]}: ${d.file}`];
  });
}

const TEMPLATES = {
  [BRD_FILE]: (title) => `# BRD — ${title}\nStatus: draft\n\n## Objetivo e valor\n(Por que a feature existe, para quem, que resultado de negócio entrega.)\n\n## Escopo\n- Dentro:\n- Fora:\n\n## Requisitos de negócio\n- RN-01:\n\n## Regras de negócio\n- (limites, permissões, cobrança, privacidade, estados)\n\n## Cenários de aceite (BDD)\n### Cenário: (nome)\n- Dado\n- Quando\n- Então\n\n## Riscos e dependências\n-\n`,
  [FLOW_FILE]: (title) => `# Exemplo SaaS do usuário — ${title}\nStatus: draft\n\n## Quem usa e onde começa\n(Persona e ponto de entrada.)\n\n## Passos\n1. \n\n## Diagrama\n\`\`\`mermaid\nflowchart TD\n  A[Entrada] --> B[Ação] --> C[Resultado]\n\`\`\`\n\n## Caminhos alternativos e erros\n-\n`,
};

/** Cria os rascunhos que ainda não existem (nunca sobrescreve). Devolve os arquivos criados. */
export function scaffoldDocs(dir, title) {
  const created = [];
  for (const [file, render] of Object.entries(TEMPLATES)) {
    const target = path.join(dir, file);
    if (fs.existsSync(target)) continue;
    fs.writeFileSync(target, render(title));
    created.push(file);
  }
  return created;
}
