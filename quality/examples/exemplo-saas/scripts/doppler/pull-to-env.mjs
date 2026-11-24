#!/usr/bin/env node
// Extrai os secrets de um config do Doppler (projeto `ofluxo`) para o .env local.
// Roda SÓ na sua máquina (teste local). Não é usado pelo deploy.
//
// Autenticação (nesta ordem):
//   1. DOPPLER_TOKEN no shell (service token dp.st.* ou token pessoal) — não interativo;
//   2. sessão do CLI (`doppler login`);
//   3. sem nenhuma das duas: abre `doppler login` (SSO no navegador).
//
// Uso:
//   node scripts/doppler/pull-to-env.mjs [--config dev|stg|prd] [--file .env]
//                                        [--dry-run] [--no-merge] [--allow-prd]
//
// Comportamento:
//   - Doppler vence em conflito; chaves só locais (ex.: JIRA_*, FLUXO_TEST_*) são
//     preservadas, a menos que use --no-merge;
//   - se algum valor local DIFERIR do Doppler (ou for só local com --no-merge),
//     o .env anterior é salvo em <file>.bak.<timestamp> (0600, ignorado pelo git)
//     ANTES de sobrescrever — assim tokens antigos nunca se perdem;
//   - nunca imprime valores, só nomes; o token nunca vai em argv, só em env do filho;
//   - `prd` exige --allow-prd (leitura de produção é exceção).
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const PROJECT = "ofluxo";
const CONFIGS = ["dev", "stg", "prd"];
const INTERNAL_PREFIX = "DOPPLER_"; // DOPPLER_PROJECT/CONFIG/ENVIRONMENT: metadados, não secrets.

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const fail = (message) => {
  console.error(`erro: ${message}`);
  process.exit(1);
};

const config = value("--config") ?? "dev";
const file = value("--file") ?? ".env";
const dryRun = flag("--dry-run");
const merge = !flag("--no-merge");

if (!CONFIGS.includes(config)) fail(`--config deve ser ${CONFIGS.join("|")}.`);
if (config === "prd" && !flag("--allow-prd")) {
  fail("config prd é produção: repita com --allow-prd se a leitura local for mesmo necessária.");
}

const doppler = (cliArgs, { token, inherit = false } = {}) => {
  const env = { ...process.env };
  if (token) env.DOPPLER_TOKEN = token;
  return spawnSync("doppler", cliArgs, {
    env,
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
};

if (doppler(["--version"]).error) fail("CLI do Doppler não encontrado (https://docs.doppler.com/docs/install-cli).");

// Token de ambiente: ignora o `.env` (nunca lemos token de arquivo do repo).
const envToken = process.env.DOPPLER_TOKEN || undefined;
const isServiceToken = envToken?.startsWith("dp.st.");

function ensureAuth() {
  if (envToken) {
    console.log(`auth: DOPPLER_TOKEN do shell (${isServiceToken ? "service token" : "token pessoal"}).`);
    return;
  }
  if (doppler(["me"]).status === 0) {
    console.log("auth: sessão do CLI (doppler login).");
    return;
  }
  console.log("auth: sem sessão — abrindo `doppler login` (SSO no navegador)…");
  if (doppler(["login", "--yes"], { inherit: true }).status !== 0) fail("login no Doppler não concluído.");
}
ensureAuth();

// Service token já é escopado a um config; para os demais, informa projeto/config.
const download = doppler(
  ["secrets", "download", "--no-file", "--format", "json", ...(isServiceToken ? [] : ["--project", PROJECT, "--config", config])],
  { token: envToken },
);
if (download.status !== 0) {
  if (/Could not find requested project/i.test(download.stderr || "")) {
    console.error(
      `dica: esta sessão do CLI não enxerga o projeto "${PROJECT}" (outro workspace?). ` +
        "Rode `doppler logout && doppler login` e escolha o workspace o_fluxo, ou exporte um service token em DOPPLER_TOKEN.",
    );
  }
  fail(`falha ao baixar ${PROJECT}/${config}: ${(download.stderr || "").trim().split("\n").pop()}`);
}

let remote;
try {
  remote = JSON.parse(download.stdout);
} catch {
  fail("resposta do Doppler não é JSON válido.");
}
const remoteSecrets = new Map(
  Object.entries(remote).filter(([name, v]) => !name.startsWith(INTERNAL_PREFIX) && typeof v === "string"),
);
if (remoteSecrets.size === 0) fail(`config ${PROJECT}/${config} está vazio — nada a extrair.`);

function parseDotenv(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const sep = t.indexOf("=");
    if (sep <= 0) continue;
    let v = t.slice(sep + 1).trim();
    if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1).replace(/\\n/g, "\n");
    map.set(t.slice(0, sep).trim(), v);
  }
  return map;
}
const quote = (v) => (/^[A-Za-z0-9_./:@%+-]*$/.test(v) ? v : JSON.stringify(v));

const hadFile = existsSync(file);
const local = hadFile ? parseDotenv(readFileSync(file, "utf8")) : new Map();

const changed = [];
const added = [];
for (const [name, v] of remoteSecrets) {
  if (!local.has(name)) added.push(name);
  else if (local.get(name) !== v) changed.push(name);
}
const localOnly = [...local.keys()].filter((name) => !remoteSecrets.has(name));
const unchanged = remoteSecrets.size - changed.length - added.length;

const final = new Map(merge ? local : []);
for (const [name, v] of remoteSecrets) final.set(name, v);

// Algo local seria perdido/trocado? Então preserva o arquivo antigo.
const needsBackup = hadFile && (changed.length > 0 || (!merge && localOnly.length > 0));

console.log(`\nDoppler ${PROJECT}/${config}: ${remoteSecrets.size} secrets`);
console.log(`  novos no .env : ${added.length}${added.length ? ` — ${added.join(", ")}` : ""}`);
console.log(`  diferentes    : ${changed.length}${changed.length ? ` — ${changed.join(", ")}` : ""}`);
console.log(`  iguais        : ${unchanged}`);
console.log(`  só locais     : ${localOnly.length}${localOnly.length ? ` — ${localOnly.join(", ")} (${merge ? "preservados" : "REMOVIDOS"})` : ""}`);

if (dryRun) {
  console.log(`\n--dry-run: nada gravado${needsBackup ? " (seria feito backup do arquivo atual)" : ""}.`);
  process.exit(0);
}

if (needsBackup) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${file}.bak.${stamp}`;
  writeFileSync(backup, readFileSync(file), { mode: 0o600 });
  chmodSync(backup, 0o600);
  console.log(`\nbackup dos valores antigos: ${backup}`);
}

const header = `# Gerado por scripts/doppler/pull-to-env.mjs de ${PROJECT}/${config} em ${new Date().toISOString()}\n# Não versionar. Edite no Doppler e rode o script de novo.\n`;
const body = [...final].map(([name, v]) => `${name}=${quote(v)}`).join("\n");
writeFileSync(file, `${header}${body}\n`, { mode: 0o600 });
chmodSync(file, 0o600);
console.log(`gravado: ${file} (${final.size} variáveis, 0600).`);
