#!/usr/bin/env node
// Importa tokens locais de um arquivo .env para um config do Doppler
// (projeto `ofluxo`). Roda SÓ na sua máquina, com a sua autenticação do CLI
// (`doppler login` ou DOPPLER_TOKEN no shell — nunca dentro do repositório).
//
// Uso:
//   node scripts/doppler/import-from-env.mjs --config prd [--file .env.local] [--only K1,K2] [--yes]
//
// Segurança:
//   - nunca imprime valores, só nomes;
//   - nunca sobe DOPPLER_TOKEN, DOPPLER_* nem JIRA_* (exclusão fixa);
//   - não sobrescreve segredos com valor vazio;
//   - pede confirmação antes de subir (exceto com --yes).
// Limitação: valores com quebra de linha não são suportados pelo formato dotenv.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const PROJECT = "ofluxo";
const EXCLUDED_PREFIXES = ["DOPPLER_", "JIRA_"];

function fail(message) {
  console.error(`erro: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
function argValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
const hasFlag = (flag) => args.includes(flag);

const config = argValue("--config");
if (!config || !["dev", "stg", "prd"].includes(config)) {
  fail("informe --config dev|stg|prd.");
}
const file = argValue("--file") ?? ".env.local";
const only = argValue("--only")?.split(",").map((name) => name.trim()).filter(Boolean) ?? null;

let raw;
try {
  raw = readFileSync(file, "utf8");
} catch {
  fail(`não foi possível ler ${file}.`);
}

const secrets = new Map();
for (const line of raw.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
  const separator = trimmed.indexOf("=");
  if (separator <= 0) continue;
  const name = trimmed.slice(0, separator).trim();
  let value = trimmed.slice(separator + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (EXCLUDED_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
  if (value.length === 0) continue;
  if (only && !only.includes(name)) continue;
  secrets.set(name, value);
}

if (secrets.size === 0) {
  fail("nenhum segredo elegível encontrado no arquivo (nem vazio, nem excluído, fora do --only).");
}

console.log(`Subindo ${secrets.size} segredo(s) para ${PROJECT}/${config} (valores não são exibidos):`);
for (const name of secrets.keys()) console.log(`  - ${name}`);

if (!hasFlag("--yes")) {
  const answer = await createInterface({ input, output }).question("Confirmar? (y/N) ");
  if (answer.trim().toLowerCase() !== "y") fail("cancelado pelo usuário.");
}

const payload = [...secrets.entries()].map(([name, value]) => `${name}=${value}`).join("\n");

// O CLI aceita filepath (não stdin): usa arquivo temporário 0600 e remove já.
const { mkdtempSync, rmSync, writeFileSync, chmodSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const dir = mkdtempSync(join(tmpdir(), "doppler-import-"));
const payloadPath = join(dir, "secrets.env");
writeFileSync(payloadPath, payload, { mode: 0o600 });
chmodSync(payloadPath, 0o600);

try {
  const uploaded = spawnSync(
    "doppler",
    ["secrets", "upload", "--project", PROJECT, "--config", config, payloadPath],
    { stdio: "inherit" },
  );
  if (uploaded.error || uploaded.status !== 0) {
    fail("doppler secrets upload falhou; verifique a autenticação do CLI (doppler login).");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\nOK. Confira em: doppler secrets --project ${PROJECT} --config ${config} --only-names`);
