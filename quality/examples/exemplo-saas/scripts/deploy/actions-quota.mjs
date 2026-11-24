#!/usr/bin/env node
// Sonda de saldo do GitHub Actions (billing) — decide Actions vs. script local no deploy.
// Regra (.claude/rules/deploy-actions-billing.md): ANTES de todo deploy, pingue o probe;
// sem saldo → deploy por script local SEMPRE (node scripts/deploy/release.mjs --run <id> --local).
//   node scripts/deploy/actions-quota.mjs --check   exit 0 = Actions com crédito; exit 1 = sem saldo/inconclusivo
//   node scripts/deploy/actions-quota.mjs --json    veredito em JSON
// Inconclusivo (billing sem escopo no token) não é "sem saldo": o orquestrador cai para a
// sonda de dispatch (deploy-probe.yml, ~2 s de runner) e para no local se ela falhar.
import { spawnSync } from 'node:child_process';
import { isMain } from '../../../../../quality/lib/is-main.mjs';
import { GH_ACTIONS_ENABLED, exitCodeProbe, vereditoJson, vereditoProbe } from './gh-actions.mjs';

const GH = process.env.FLUXO_GH || 'gh';

function ghOut(args) {
  if (!GH_ACTIONS_ENABLED) return null; // chave dura: nenhum subprocesso gh
  const r = spawnSync(GH, args, { encoding: 'utf8', timeout: 30_000 });
  return r.status === 0 ? r.stdout : null;
}

/** Campos necessários para decidir: totais numéricos e included_minutes > 0 (0 não separa overage de esgotado). */
function camposValidos(b) {
  return b != null
    && typeof b.total_minutes_used === 'number'
    && typeof b.included_minutes === 'number'
    && b.included_minutes > 0;
}

function parseBilling(raw) {
  try {
    const b = JSON.parse(raw);
    if (!camposValidos(b)) return null;
    return { ok: b.total_minutes_used < b.included_minutes, used: b.total_minutes_used, included: b.included_minutes };
  } catch {
    return null;
  }
}

function loginDoRepo() {
  const view = ghOut(['repo', 'view', '--json', 'owner']);
  if (!view) return null;
  try {
    return JSON.parse(view)?.owner?.login ?? null;
  } catch {
    return null;
  }
}

/** Lê o billing do dono do repo (user ou org). {ok, used, included} ou null quando inconclusivo. */
export function billingInfo() {
  const login = loginDoRepo();
  if (!login) return null;
  for (const endpoint of [`users/${login}`, `orgs/${login}`]) {
    const raw = ghOut(['api', endpoint]);
    if (raw) {
      const info = parseBilling(raw);
      if (info) return info;
    }
  }
  return null;
}

export function vereditoTexto(info) {
  if (!info) return 'Actions INCONCLUSIVO (billing sem escopo no token) — siga com release.mjs --run: a sonda de dispatch decide';
  if (info.ok) return `Actions COM CRÉDITO (${info.used}/${info.included} min usados) — pode disparar esteiras`;
  return `Actions SEM SALDO (${info.used}/${info.included} min usados) — deploy por script local SEMPRE: node scripts/deploy/release.mjs --run <id> --local`;
}

if (isMain(import.meta.url)) {
  const info = billingInfo();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(vereditoJson(info), null, 2));
  } else {
    console.log(vereditoProbe(info, vereditoTexto));
  }
  process.exitCode = exitCodeProbe(info);
}
