#!/usr/bin/env node
// Espelha as regras sempre ativas de .claude/rules/ para o Cline (.clinerules/*.md, formato
// de diretório lido por todas as versões do Cline). O Cline não resolve `@import`, então a
// regra vira cópia gerada; --check reprova (exit 2) se a cópia divergir da fonte.
// Também gera o índice de skills e agentes (.clinerules/80-skills-e-agentes.md): o Cline não
// tem loader de skills/agents do Claude — o índice diz o que existe e qual arquivo ler.
//   node quality/agents/sync-clinerules.mjs          grava/atualiza as cópias e o índice
//   node quality/agents/sync-clinerules.mjs --check  só verifica (CI e testes)
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../lib/util.mjs';
import { isMain } from '../lib/is-main.mjs';
import { PROFILE } from '../lib/profile.mjs';

/** fonte em .claude/rules → destino em .clinerules (prefixo numérico define a ordem de leitura). */
export const MIRRORS = [
  { source: 'economia-de-tokens.md', target: '10-economia-de-tokens.md' },
  { source: 'autofix-gates.md', target: '20-autofix-gates.md' },
  { source: 'comandos-curtos.md', target: '30-comandos-curtos.md' },
  { source: 'deploy-actions-billing.md', target: '40-deploy-actions-billing.md' },
  { source: 'gitflow-branches.md', target: '50-gitflow-branches.md' },
  { source: 'backlog-e-gates.md', target: '60-backlog-e-gates.md' },
];

const header = (source) => `<!-- GERADO por quality/agents/sync-clinerules.mjs a partir de .claude/rules/${source}. Não edite aqui. -->\n\n`;

export function expected(root, mirror) {
  return header(mirror.source) + fs.readFileSync(path.join(root, '.claude', 'rules', mirror.source), 'utf8');
}

const campo = (frontmatter, nome) => {
  const m = new RegExp(`^${nome}:\\s*(.+)$`, 'm').exec(frontmatter);
  return m ? m[1].trim() : '';
};

const primeiraFrase = (texto, max = 110) => {
  const frase = String(texto ?? '').split(/(?<=\.)\s/)[0] ?? '';
  return frase.length > max ? `${frase.slice(0, max - 1)}…` : frase;
};

/** Índice gerado dos frontmatters de .claude/skills (tema)/SKILL.md e .claude/agents (papel).md. */
export function generateIndex(root) {
  const banner = '<!-- GERADO por quality/agents/sync-clinerules.mjs. Não edite aqui. -->\n\n'
    + '# Skills e agentes do harness (Claude Code ↔ Cline)\n\n'
    + 'Um conteúdo, dois hosts: o Claude Code carrega estes arquivos automaticamente; no Cline,\n'
    + 'LEIA o arquivo indicado antes de editar o domínio correspondente (AGENTS.md §7).\n\n';
  const skillsDir = path.join(root, '.claude', 'skills');
  const temas = fs.existsSync(skillsDir)
    ? fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];
  // Skills de domínio do projeto (perfil, prompt.domainSkills) ganham a marca de overlay.
  const overlaySkills = (PROFILE.prompt && PROFILE.prompt.domainSkills) || [];
  const linhasSkills = temas.map((tema) => {
    const fm = (() => {
      try { return fs.readFileSync(path.join(skillsDir, tema, 'SKILL.md'), 'utf8').split('---')[1] ?? ''; } catch { return ''; }
    })();
    const marca = overlaySkills.includes(tema) ? ' *(overlay)*' : '';
    return `| ${tema}${marca} | ${primeiraFrase(campo(fm, 'description'))} |`;
  });
  const agentsDir = path.join(root, '.claude', 'agents');
  const agentes = fs.existsSync(agentsDir)
    ? fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md')).sort()
    : [];
  const linhasAgents = agentes.map((arquivo) => {
    const fm = (() => {
      try { return fs.readFileSync(path.join(agentsDir, arquivo), 'utf8').split('---')[1] ?? ''; } catch { return ''; }
    })();
    return `| ${campo(fm, 'name') || arquivo.replace('.md', '')} | ${primeiraFrase(campo(fm, 'description'))} |`;
  });
  return banner
    + '## Skills — leia `.claude/skills/<tema>/SKILL.md` antes de editar o domínio\n\n'
    + '| Tema | Quando ler |\n|---|---|\n'
    + `${linhasSkills.join('\n')}\n\n`
    + '## Agents — leia `.claude/agents/<papel>.md` antes de delegar/imitar o papel\n\n'
    + '| Papel | Quando usar |\n|---|---|\n'
    + `${linhasAgents.join('\n')}\n`;
}

const INDEX_TARGET = '80-skills-e-agentes.md';

export function sync(root, { check = false } = {}) {
  const drift = [];
  for (const mirror of MIRRORS) {
    const target = path.join(root, '.clinerules', mirror.target);
    const want = expected(root, mirror);
    const have = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (have === want) continue;
    drift.push(mirror.target);
    if (!check) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, want);
    }
  }
  // Índice (80) só quando o root tem skills/agents: em raiz sem fontes, gerar/countar índice
  // criava drift falso (bug herdado do monorepo — corrigido na apartação do Omni Harness).
  const temFonteDeIndex = fs.existsSync(path.join(root, '.claude', 'skills'))
    || fs.existsSync(path.join(root, '.claude', 'agents'));
  if (temFonteDeIndex) {
    const indexTarget = path.join(root, '.clinerules', INDEX_TARGET);
    const index = generateIndex(root);
    const indexHave = fs.existsSync(indexTarget) ? fs.readFileSync(indexTarget, 'utf8') : null;
    if (indexHave !== index) {
      drift.push(INDEX_TARGET);
      if (!check) fs.writeFileSync(indexTarget, index);
    }
  }
  // R2 — espelho do overlay de projeto quando o perfil o define (.clinerules/85-projeto.md).
  // O arquivo-fonte deve existir NO root informado (em repo de teste sem overlay, nada a fazer).
  const overlayRel = PROFILE.prompt && PROFILE.prompt.overlay;
  if (overlayRel) {
    const overlayAbs = path.join(root, overlayRel);
    if (fs.existsSync(overlayAbs)) {
      const overlayTarget = path.join(root, '.clinerules', '85-projeto.md');
      const overlayWant = `<!-- GERADO por quality/agents/sync-clinerules.mjs a partir de ${overlayRel}. Não edite aqui. -->\n\n`
        + fs.readFileSync(overlayAbs, 'utf8');
      const overlayHave = fs.existsSync(overlayTarget) ? fs.readFileSync(overlayTarget, 'utf8') : null;
      if (overlayHave !== overlayWant) {
        drift.push('85-projeto.md');
        if (!check) fs.writeFileSync(overlayTarget, overlayWant);
      }
    }
  }
  return drift;
}

if (isMain(import.meta.url)) {
  const check = process.argv.includes('--check');
  const drift = sync(repoRoot(), { check });
  if (check && drift.length) {
    process.stderr.write(`.clinerules fora de sincronia (${drift.join(', ')}). Rode: node quality/agents/sync-clinerules.mjs\n`);
    process.exit(2);
  }
  process.stdout.write(check ? 'ok: .clinerules em sincronia\n' : `espelhado: ${drift.length ? drift.join(', ') : 'nada a mudar'}\n`);
}
