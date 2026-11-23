// Reconhece commit, push e deploy em comandos Bash sem falsos positivos em strings,
// mensagens de commit, heredocs ou echo. Não executa nada.

/** Remove corpos de heredoc (<<EOF … EOF), mantendo a linha que abre o heredoc. */
export function stripHeredocs(cmd) {
  const out = [];
  const pending = [];
  for (const line of cmd.split('\n')) {
    if (pending.length) {
      const [word, dash] = pending[0];
      if ((dash ? line.trim() : line) === word || line.trim() === word) pending.shift();
      continue;
    }
    out.push(line);
    for (const m of line.matchAll(/<<(-?)\s*(['"]?)([A-Za-z_][\w]*)\2/g)) pending.push([m[3], m[1] === '-']);
  }
  return out.join('\n');
}

/** Divide em comandos simples nos operadores ; & | && || e quebras de linha fora de aspas e de $( ). */
export function splitCommands(cmd) {
  const segs = [];
  const st = { cur: '', quote: null, depth: 0 };
  const flush = () => { if (st.cur.trim()) segs.push(st.cur.trim()); st.cur = ''; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === '\\' && st.quote !== "'") { st.cur += c + (cmd[i + 1] ?? ''); i++; continue; }
    if (c === '$' && cmd[i + 1] === '(' && st.quote !== "'") { st.depth++; st.cur += '$('; i++; continue; }
    if (st.quote) { quotedChar(st, c); continue; }
    if (c === "'" || c === '"' || c === '`') { st.quote = c; st.cur += c; continue; }
    if (c === ')' && st.depth > 0) { st.depth--; st.cur += c; continue; }
    if (st.depth === 0 && ';&|\n'.includes(c)) { flush(); continue; }
    st.cur += c;
  }
  flush();
  return segs;
}

function quotedChar(st, c) {
  if (c === st.quote) st.quote = null;
  else if (st.quote === '"' && c === ')' && st.depth > 0) st.depth--;
  st.cur += c;
}

/** Palavras de um comando simples, sem aspas. */
export function words(segment) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (c === '\\') { cur += segment[i + 1] ?? ''; i++; has = true; continue; }
    if (/\s/.test(c)) { if (has || cur) out.push(cur); cur = ''; has = false; continue; }
    cur += c;
    has = true;
  }
  if (has || cur) out.push(cur);
  return out;
}

const PREFIXES = new Set(['sudo', 'rtk', 'command', 'time', 'nohup', 'env', 'exec', 'npx', 'pnpx', 'bunx']);

function program(ws) {
  let i = 0;
  while (i < ws.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[i]) || PREFIXES.has(ws[i]) || (ws[i].startsWith('-') && i > 0 && PREFIXES.has(ws[i - 1])))) i++;
  return ws.slice(i);
}

const COST_FLAGS = ['--min-instances', '--max-instances', '--cpu', '--memory', '--concurrency', '--tier', '--schedule', '--timeout'];

function costFlags(ws) {
  return COST_FLAGS.filter((f) => ws.some((w) => w === f || w.startsWith(`${f}=`)));
}

/** Palavras que não são opções, preservando a ordem (para subcomandos do gcloud etc.). */
const positional = (ws) => ws.filter((w) => !w.startsWith('-'));

const GIT_OPTS_WITH_VALUE = ['-C', '-c', '--git-dir', '--work-tree', '--namespace'];

function classifyGit(rest, segment) {
  let i = 0;
  while (i < rest.length && rest[i].startsWith('-')) i += GIT_OPTS_WITH_VALUE.includes(rest[i]) ? 2 : 1;
  const [sub, ...args] = rest.slice(i);
  if (args.includes('--help') || args.includes('-h')) return null;
  if (sub === 'commit') return { type: 'commit', text: segment, costFlags: [] };
  const dryRun = args.includes('--dry-run') || args.includes('-n');
  return sub === 'push' && !dryRun ? { type: 'push', text: segment, costFlags: [] } : null;
}

const GCLOUD_DEPLOYS = [
  [/^run (deploy|services (update|replace|update-traffic)|jobs (deploy|update|create|execute|replace))/, []],
  [/^scheduler jobs (create|update|resume)/, ['scheduler']],
  [/^(builds submit|functions deploy|app deploy)/, []],
  [/^sql instances (patch|create)/, ['cloud-sql']],
];

function classifyGcloud(pos) {
  const p = pos[0] === 'beta' || pos[0] === 'alpha' ? pos.slice(1) : pos;
  const key = p.slice(0, 3).join(' ');
  const hit = GCLOUD_DEPLOYS.find(([re]) => re.test(key));
  return hit ? hit[1] : null;
}

const PKG_OPTS_WITH_VALUE = ['--prefix', '-C', '--dir', '--filter'];

function classifyPackageManager(rest) {
  let i = 0;
  while (i < rest.length && rest[i].startsWith('-')) i += PKG_OPTS_WITH_VALUE.includes(rest[i]) ? 2 : 1;
  const sub = rest[i] === 'run' || rest[i] === 'run-script' ? rest[i + 1] : rest[i];
  return sub && /^deploy(:|$)/.test(sub) ? [] : null;
}

function classifyScript(cmd, base, pos) {
  const script = /\.sh$/.test(base) ? cmd : pos[0];
  return script && /deploy|cutover|release/i.test(script.split('/').pop()) ? [] : null;
}

/** Devolve flags extras de custo se o programa for um deploy, ou null. */
function deployFlags(cmd, base, rest) {
  const pos = positional(rest);
  if (base === 'firebase' || base === 'firebase-tools') return pos[0] === 'deploy' ? [] : null;
  if (base === 'gcloud') return classifyGcloud(pos);
  if (base === 'terraform') return pos.includes('apply') || pos.includes('destroy') ? ['terraform'] : null;
  if (base === 'dotnet') return pos.slice(0, 3).join(' ') === 'ef database update' ? ['migration'] : null;
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(base)) return classifyPackageManager(rest);
  if (['bash', 'sh', 'zsh'].includes(base) || /\.sh$/.test(base)) return classifyScript(cmd, base, pos);
  return null;
}

function classifySegment(segment) {
  const ws = program(words(segment));
  if (ws.length === 0) return null;
  const [cmd, ...rest] = ws;
  const base = cmd.split('/').pop();
  if (base === 'git') return classifyGit(rest, segment);
  const extra = deployFlags(cmd, base, rest);
  return extra ? { type: 'deploy', text: segment, costFlags: [...costFlags(ws), ...extra] } : null;
}

/** Ações relevantes (commit/push/deploy) de um comando Bash completo. */
export function classifyCommand(cmd) {
  if (!cmd || !/\b(git|firebase|gcloud|terraform|dotnet|npm|pnpm|yarn|bun)\b|deploy|cutover|release/i.test(cmd)) return [];
  const actions = [];
  for (const seg of splitCommands(stripHeredocs(cmd))) {
    const a = classifySegment(seg);
    if (a) actions.push(a);
    // Comandos aninhados em bash -c / sh -c "…"
    const ws = program(words(seg));
    if (['bash', 'sh', 'zsh'].includes(ws[0]) && ws[1] === '-c' && ws[2]) actions.push(...classifyCommand(ws[2]));
  }
  return actions;
}
