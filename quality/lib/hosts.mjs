// Registro de hosts de agente (R-distribuição): o núcleo (quality/) é host-agnóstico e é
// instalado SEMPRE; o que muda por host é a camada de integração. Hosts com hooks nativos
// (Claude Code, Cline) recebem os hooks; os demais recebem um CARRIER de instruções apontando
// para AGENTS.md + CLI do motor (node quality/run.mjs), porque não têm hooks de repositório.
//
// R-pendência (estruturas proprietárias mudam rápido): os PATHS são DADO, não código. Os
// defaults estão aqui; o hospedeiro sobrescreve o que quiser em `quality/hosts.json`
// (formato: { "hosts": { "<id>": { "carrier": "...", "integration": [...] } } }) — resolvido
// por resolveHosts(root). Assim, quando o vendor mudar o caminho, atualiza dado, não lib.
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './util.mjs';

export const HOSTS = [
  {
    id: 'claude-code',
    nome: 'Claude Code',
    integration: ['.claude/settings.json', '.claude/hooks/'],
    nota: 'hooks nativos (SessionStart/PreToolUse/PostToolUse/Stop/SubagentStop) registrados no settings.json',
  },
  {
    id: 'cline',
    nome: 'Cline',
    integration: [
      '.clinerules/hooks/PreToolUse',
      '.clinerules/hooks/PostToolUse',
      '.clinerules/hooks/TaskStart',
      '.clinerules/hooks/TaskResume',
      '.clinerules/hooks/TaskComplete',
    ],
    nota: 'hooks finos que delegam ao cline-bridge; regras espelhadas em .clinerules/*.md pelo sync',
  },
  {
    id: 'codex',
    nome: 'Codex CLI (OpenAI)',
    integration: [],
    nota: 'lê AGENTS.md da raiz (padrão cross-tool); sem hooks de repositório — gates via CLI',
  },
  {
    id: 'vscode',
    nome: 'VS Code (Copilot)',
    carrier: { path: '.github/copilot-instructions.md' },
    integration: [],
    nota: 'custom instructions do Copilot Chat apontam para AGENTS.md e os gates via CLI',
  },
  {
    id: 'antigravity',
    nome: 'Antigravity (Google)',
    carrier: { path: '.antigravity/rules/omni-harness.md' },
    integration: [],
    nota: 'carrier de regras do workspace; o AGENTS.md da raiz também é lido',
  },
  {
    id: 'kiro',
    nome: 'Kiro (AWS)',
    carrier: { path: '.kiro/steering/omni-harness.md' },
    integration: [],
    nota: 'steering sempre-on; specs do Kiro continuam no fluxo do hospedeiro',
  },
];

export const DEFAULT_HOSTS = ['claude-code', 'cline'];
export const ALL_IDS = HOSTS.map((h) => h.id);

/** Normaliza carrier de um host resolvido: string | {path} → { path }. */
function normalizeCarrier(host) {
  const c = host.carrier;
  if (c == null) return null;
  return typeof c === 'string' ? { path: c } : { path: c.path };
}

/**
 * Hosts RESOLVIDOS para um repositório hospedeiro: defaults do núcleo + overrides de
 * `quality/hosts.json` (dado do host — estruturas proprietárias mudam sem tocar a lib).
 * Nunca lança: override ilegível é reportado em erros[] e os defaults prevalecem.
 */
export function resolveHosts(root, env = process.env) {
  const erros = [];
  const resolved = HOSTS.map((h) => ({ ...h, integration: [...h.integration], carrier: normalizeCarrier(h) }));
  if (!root) return { hosts: resolved, erros };
  const overridePath = env.HARNESS_HOSTS_JSON || path.join(root, 'quality', 'hosts.json');
  const overrides = fs.existsSync(overridePath) ? readJson(overridePath, null) : null;
  if (overrides == null && fs.existsSync(overridePath)) erros.push(`hosts.json ilegível (JSON inválido): ${overridePath}`);
  if (overrides == null) return { hosts: resolved, erros };
  const porId = overrides.hosts && typeof overrides.hosts === 'object' && !Array.isArray(overrides.hosts) ? overrides.hosts : null;
  if (!porId) {
    if (overrides.hosts != null) erros.push('hosts.json: "hosts" deve ser objeto { <id>: { carrier, integration } }');
    return { hosts: resolved, erros };
  }
  for (const [id, over] of Object.entries(porId)) {
    const host = resolved.find((h) => h.id === id);
    if (!host) { erros.push(`hosts.json: override para host desconhecido "${id}"`); continue; }
    if (over == null || typeof over !== 'object' || Array.isArray(over)) {
      erros.push(`hosts.json: override de "${id}" deve ser objeto`);
      continue;
    }
    if (over.carrier != null) {
      // Carrier é GERADO no destino (não copiado do núcleo): nunca entra em integration.
      host.carrier = typeof over.carrier === 'string' ? { path: over.carrier } : over.carrier;
    }
    if (over.integration != null) {
      if (!Array.isArray(over.integration)) erros.push(`hosts.json: integration de "${id}" deve ser lista`);
      else host.integration = over.integration;
    }
  }
  return { hosts: resolved, erros };
}

/** 'all' | 'a,b,c' → ids válidos; id desconhecido devolve erro em erros[]. */
export function parseHosts(spec, erros = []) {
  const pedido = (spec ?? '').trim();
  if (!pedido) return { ids: [...DEFAULT_HOSTS], erros };
  if (pedido === 'all' || pedido === '*') return { ids: [...ALL_IDS], erros };
  const ids = pedido.split(',').map((s) => s.trim()).filter(Boolean);
  const inválidos = ids.filter((id) => !ALL_IDS.includes(id));
  if (inválidos.length) erros.push(`hosts desconhecidos: ${inválidos.join(', ')} (válidos: ${ALL_IDS.join(', ')})`);
  return { ids: ids.filter((id) => ALL_IDS.includes(id)), erros };
}

/** Carrier de instruções para hosts sem hooks de repositório. Conteúdo autocontido e curto. */
export function carrierContent(nomeProjeto) {
  return `# Omni Harness — instruções do agente (host sem hooks de repositório)

Projeto: ${nomeProjeto || '(projeto hospedeiro)'}

Este projeto usa o **Omni Harness** (motor Node 22 em \`quality/\`). Este host não executa os hooks
do harness — então a disciplina vira **contrato que VOCÊ executa via CLI**, na ordem:

1. **Contexto primeiro:** leia \`AGENTS.md\` na raiz (núcleo) e o overlay do projeto indicado no
   perfil (\`quality/profile/\`, campo \`prompt.overlay\`). Docs por workflow: \`docs/harness/INDEX.md\`.
2. **Buscar código:** \`graphify query "<Identificador>"\` antes de Grep/Glob; depois \`Read\` com
   \`offset\`/\`limit\` só nos trechos apontados.
3. **Antes de terminar qualquer tarefa:** rode o motor e trate o veredito — \`ALERTA\`/\`IGNORADO\`
   não são aprovação:

   \`\`\`bash
   node quality/run.mjs --tier rapido
   node quality/delivery/backlog.mjs status docs/entregas/<slug>   # se houver entrega ativa
   \`\`\`

4. **Regras permanentes:** \`.claude/rules/\` (economia de tokens, comandos curtos, autofix,
   gitflow, tracker, layering do projeto). São texto — leia as citadas pela tarefa.
5. **Perfil:** tudo que varia por projeto (camadas, fronteiras, runners, tracker, gitflow, PII,
   locale) vive em \`quality/profile/\` — nunca no motor.

Referência completa: \`docs/harness/INDEX.md\` · Instalador: \`omni-harness init <destino>\`.
`;
}

/** Carrier de um host (objeto resolvido ou id): { relPath, content, dir } | null. */
export function carrierFor(hostOrId, nomeProjeto) {
  const host = typeof hostOrId === 'string'
    ? HOSTS.find((h) => h.id === hostOrId)
    : hostOrId;
  const c = host && host.carrier;
  if (!host || !c || !c.path) return null;
  const relPath = c.path;
  return { relPath, content: carrierContent(nomeProjeto), dir: path.posix.dirname(relPath) };
}
