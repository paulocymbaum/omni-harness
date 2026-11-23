// Gates DV-003 — worker de ingestão (services/debate-worker): fontes file/url/device, Soniox ao vivo atrás de
// AsrStream, junção de falas, falas pela API /api/v1/internal/* e comando debate:replay.
// ANTES da implementação cada gate DEVE falhar: o pacote services/debate-worker ainda não existe.
// Rode: node quality/delivery/eval.mjs docs/entregas/2026-10-21-debate-ao-vivo DV-003 --baseline
//
// Tudo roda sem rede externa: Soniox, API e GCS são falsos/locais (servidor ws/http em 127.0.0.1, Storage falso,
// ASR de fixture). Os gates que delegam ao Vitest exigem títulos que COMEÇAM pelo marcador (ex.:
// "DV-003 JOINER-GAP — junta segmentos com intervalo < 1500 ms"); marcador ausente, skip/todo ou falha reprova.
// O gate replay-utterances também confere a saída do `npm run debate:replay -- --dry-run` diretamente.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, WORKER, requireWorkerDeps, runAsync, runOk, runVitestMarkers, tail } from './dv-worker-gate-helper.mjs';

const W = (rel) => path.join(WORKER, rel);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function walk(dir, pred, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'dist') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, pred, acc);
    else if (pred(p)) acc.push(p);
  }
  return acc;
}

// ── replay ───────────────────────────────────────────────────────────────────

const SPECIAL = new Set(['<end>', '<fin>']);

function loadFixtureTokens(file) {
  const tokens = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    for (const t of msg.tokens ?? []) {
      if (t.is_final === true && !SPECIAL.has(String(t.text).trim())) tokens.push(t);
    }
  }
  return tokens;
}

function parseDryRun(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
    const rec = JSON.parse(l);
    const headers = rec.headers ?? {};
    return {
      method: rec.method,
      route: rec.route ?? rec.path ?? rec.url ?? rec.rota,
      key: rec.idempotencyKey ?? rec['Idempotency-Key'] ?? headers['Idempotency-Key'] ?? headers['idempotency-key'],
      body: rec.body ?? rec.corpo,
    };
  });
}

function startCountingServer() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"code":"dry_run_must_not_call"}');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, hits, port: server.address().port })));
}

test('DV-003 replay-utterances: replay de 5 min (fixture Soniox, relógio virtual, dry-run) gera falas válidas', async () => {
  requireWorkerDeps();
  const fixture = W('test/fixtures/soniox-5min.jsonl');
  assert.ok(fs.existsSync(fixture), 'fixture test/fixtures/soniox-5min.jsonl ausente');
  const tokens = loadFixtureTokens(fixture);
  const speakers = new Set(tokens.map((t) => String(t.speaker)));
  assert.ok(speakers.size >= 3, `fixture precisa de >= 3 falantes, tem ${speakers.size}`);
  const maxEnd = Math.max(...tokens.map((t) => t.end_ms));
  assert.ok(maxEnd >= 240_000 && maxEnd <= 300_000, `fixture deve cobrir ~5 min de áudio (max end_ms=${maxEnd})`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dv003-replay-'));
  const { server, hits, port } = await startCountingServer();
  try {
    const wav = path.join(tmp, 'sine-5min.wav');
    runOk('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=300',
      '-ac', '1', '-ar', '16000', wav], { label: 'ffmpeg lavfi' });
    const out = path.join(tmp, 'dry-run.jsonl');
    const env = {
      ...process.env,
      FLUXO_API_BASE_URL: `http://127.0.0.1:${port}`,
      FLUXO_API_AUDIENCE: `http://127.0.0.1:${port}`,
      STORAGE_EMULATOR_HOST: `http://127.0.0.1:${port}`,
      SONIOX_API_KEY: 'test-key-not-real',
      SONIOX_MODEL: 'stt-rt-v5',
      DEBATE_AUDIO_BUCKET: 'fluxo-ath-debates-audio',
    };
    const r = await runAsync('npm', ['--prefix', WORKER, 'run', '--silent', 'debate:replay', '--',
      '--file', wav, '--asr', 'fixture', '--asr-fixture', fixture, '--clock', 'virtual', '--dry-run', out],
    { cwd: WORKER, env, timeout: 55_000 });
    assert.equal(r.error, undefined, `debate:replay não executou (${r.error?.message})`);
    assert.equal(r.code, 0, `debate:replay saiu com ${r.code} ${r.signal ?? ''}:\n${tail(r.stdout + r.stderr)}`);
    assert.deepEqual(hits.filter((h) => /\/api\/v1\//.test(h)), [], '--dry-run não pode chamar a API');
    assert.ok(fs.existsSync(out), 'dry-run não gravou o JSONL');

    const utts = parseDryRun(out).filter((x) => /\/internal\/debates\/[^/]+\/utterances$/.test(x.route ?? ''));
    assert.ok(utts.length >= 6, `esperava várias falas, veio ${utts.length}`);
    const keys = new Set();
    let prev = null;
    let joinedPause = false;
    let capSplit = false;
    let pauseSplit = false;
    const captureStartedAt = utts[0].body?.captureStartedAt;
    assert.ok(!Number.isNaN(Date.parse(captureStartedAt)), 'captureStartedAt deve ser instante ISO');
    for (const { method, key, body: u } of utts) {
      if (method !== undefined) assert.equal(method, 'POST');
      assert.equal(u.origin, 'live');
      assert.equal(u.asrProvider, 'soniox');
      assert.equal(typeof u.asrModel, 'string');
      assert.equal(u.captureStartedAt, captureStartedAt, 'captureStartedAt é o mesmo em toda fala');
      assert.match(u.speakerLabel, /^s1-\S+$/, `rótulo com prefixo de sessão: ${u.speakerLabel}`);
      assert.equal(key, `utt:${key?.split(':')[1]}:${u.ingestionId}:${u.seq}`, `Idempotency-Key fora do formato utt:<debate>:<ingestion>:<seq>: ${key}`);
      assert.ok(!keys.has(key), `Idempotency-Key duplicada: ${key}`);
      keys.add(key);
      assert.ok(u.endMs > u.startMs, `fala com duração inválida: ${u.startMs}-${u.endMs}`);
      assert.ok(u.endMs - u.startMs <= 30_000, `fala acima de 30 s: ${u.endMs - u.startMs} ms`);
      assert.equal(u.text, u.text.trim());
      assert.doesNotMatch(u.text, /\s{2,}|<end>|<fin>/, `texto não normalizado: ${u.text}`);
      assert.ok(u.text.length > 0, 'fala vazia não pode ser enviada');

      const inside = tokens.filter((t) => t.start_ms >= u.startMs && t.end_ms <= u.endMs);
      assert.ok(inside.length > 0, `fala ${u.seq} não corresponde a tokens da fixture`);
      const own = new Set(inside.map((t) => String(t.speaker)));
      assert.equal(own.size, 1, `fala ${u.seq} mistura falantes ${[...own]}`);
      assert.equal(u.speakerLabel, `s1-${[...own][0]}`, 'rótulo = s<sessão>-<speaker do Soniox>');
      for (let i = 1; i < inside.length; i++) {
        const gap = inside[i].start_ms - inside[i - 1].end_ms;
        if (gap >= 500 && gap < 1500) joinedPause = true;
      }

      if (prev) {
        assert.ok(u.seq > prev.seq, 'seq crescente');
        assert.ok(u.startMs >= prev.endMs, `offsets crescentes: ${prev.endMs} > ${u.startMs}`);
        if (u.speakerLabel === prev.speakerLabel) {
          const gap = u.startMs - prev.endMs;
          const wouldExceed = u.endMs - prev.startMs > 30_000;
          assert.ok(gap >= 1500 || wouldExceed, `falas ${prev.seq}/${u.seq} do mesmo falante com intervalo ${gap} ms deviam estar juntas`);
          if (gap < 1500) capSplit = true; else pauseSplit = true;
        }
      }
      prev = u;
    }
    assert.ok(new Set(utts.map((x) => x.body.speakerLabel)).size === speakers.size, 'todo falante da fixture aparece nas falas');
    const strip = (s) => s.replace(/\s+/g, '');
    assert.equal(strip(utts.map((x) => x.body.text).join('')), strip(tokens.map((t) => t.text).join('')),
      'texto das falas = tokens finais da fixture (nada perdido, nada duplicado)');
    assert.ok(joinedPause, 'fixture deve exercitar pausa < 1,5 s dentro da mesma fala');
    assert.ok(pauseSplit, 'fixture deve exercitar corte por pausa >= 1,5 s do mesmo falante');
    assert.ok(capSplit, 'fixture deve exercitar corte pelo teto de 30 s');
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  runVitestMarkers([
    'DV-003 REPLAY-E2E',
    'DV-003 JOINER-GAP',
    'DV-003 JOINER-GAP-EXACT-1500',
    'DV-003 JOINER-SPEAKER-CHANGE',
    'DV-003 JOINER-30S-CAP',
    'DV-003 JOINER-FINAL-AUDIO-ADVANCE',
    'DV-003 JOINER-INVARIANTS',
  ], { timeout: 55_000 });
});

test('DV-003 replay-test-only: replay com --debate só escreve em debate isTest e --dry-run não chama a API', () => {
  // REPLAY-REQUIRES-TEST-DEBATE: API falsa com isTest=false → exit 3, replay_requires_test_debate, zero POST.
  // REPLAY-DRY-RUN-NO-API: --dry-run grava rota, Idempotency-Key e corpo e não abre conexão com a API.
  runVitestMarkers(['DV-003 REPLAY-REQUIRES-TEST-DEBATE', 'DV-003 REPLAY-DRY-RUN-NO-API']);
});

// ── captura ──────────────────────────────────────────────────────────────────

test('DV-003 source-url-hls: fonte url lê HLS local e entrega PCM s16le mono 16 kHz em pacotes fixos de 100–250 ms', () => {
  runVitestMarkers([
    'DV-003 URL-HLS-PCM',
    'DV-003 CHUNKER-FIXED-SIZE',
    'DV-003 CHUNKER-RANGE',
    'DV-003 CHUNKER-TAIL-ONLY-AT-END',
  ]);
});

test('DV-003 source-safety: -re por fonte, protocolos ffmpeg restritos, yt-dlp só com flag local e fora da imagem', () => {
  const dockerfile = W('Dockerfile');
  assert.ok(fs.existsSync(dockerfile), 'services/debate-worker/Dockerfile ausente');
  const lines = fs.readFileSync(dockerfile, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l));
  const body = lines.join('\n');
  assert.match(body, /FROM\s+node:22-slim/i, 'imagem base node:22-slim');
  assert.ok((body.match(/^\s*FROM\s/gim) ?? []).length >= 2, 'Dockerfile em dois estágios');
  assert.match(body, /apt-get[^\n]*install[^\n]*\bffmpeg\b/, 'runtime instala ffmpeg via apt');
  assert.doesNotMatch(body, /yt-dlp|youtube-dl/i, 'a imagem de produção não instala yt-dlp');
  assert.match(body, /dist\/index\.js/, 'entrada node dist/index.js');
  runVitestMarkers([
    'DV-003 FFMPEG-TWO-OUTPUTS',
    'DV-003 FFMPEG-RE-BY-SOURCE',
    'DV-003 FFMPEG-URL-PROTOCOLS',
    'DV-003 FFMPEG-YTDLP-GUARD',
    'DV-003 FFMPEG-FAILURE-REDACTED',
  ]);
});

test('DV-003 recorder-parts: partes Opus sobem com caminho/metadados, última parte no SIGTERM, upload falho não para o PCM', () => {
  runVitestMarkers([
    'DV-003 RECORDER-UPLOAD-PATH-METADATA',
    'DV-003 RECORDER-LAST-PART-ON-SIGTERM',
    'DV-003 RECORDER-UPLOAD-FAILURE-KEEPS-PCM',
  ]);
});

// ── ASR ──────────────────────────────────────────────────────────────────────

test('DV-003 soniox-config: mensagem inicial stt-rt-v5/pcm_s16le/16000/1/pt, diarização, sem endpoint, context e chave só no header', () => {
  runVitestMarkers([
    'DV-003 SONIOX-AUTH-HEADER',
    'DV-003 SONIOX-START-MESSAGE',
    'DV-003 SONIOX-END-OF-AUDIO',
    'DV-003 SONIOX-TOKENS',
    'DV-003 SONIOX-ERROR-TYPE',
  ]);
});

test('DV-003 reconnect-clock: queda reconecta com backoff, preserva relógio, prefixa rótulos e registra buraco; erro permanente não laça', () => {
  runVitestMarkers([
    'DV-003 CLOCK-SAMPLES',
    'DV-003 RECONNECT-503',
    'DV-003 RECONNECT-1006',
    'DV-003 RECONNECT-PERMANENT-FAILS',
    'DV-003 RECONNECT-429-WAIT',
    'DV-003 RECONNECT-ROTATE-290MIN',
  ]);
});

// ── API ──────────────────────────────────────────────────────────────────────

test('DV-003 api-client: ID token com audience, Idempotency-Key determinística, 4xx sem retry, outbox em ordem, stop pelo heartbeat', () => {
  runVitestMarkers([
    'DV-003 API-OIDC-AUDIENCE',
    'DV-003 API-IDEMPOTENCY-RETRY',
    'DV-003 API-4XX-NO-RETRY',
    'DV-003 API-OUTBOX-ORDER',
    'DV-003 API-PARTIAL-DISCARDABLE',
    'DV-003 API-STOP-FROM-HEARTBEAT',
    'DV-003 API-ASR-LIVE-AI-RUN',
  ]);
});

test('DV-003 no-db-credentials: sem driver de banco nem SDK Firestore; só URLs sob /api/v1/internal/', () => {
  const pkgPath = W('package.json');
  assert.ok(fs.existsSync(pkgPath), 'services/debate-worker/package.json ausente');
  const pkg = readJson(pkgPath);
  const FORBIDDEN = ['pg', 'postgres', 'pg-promise', 'firebase-admin', 'firebase', '@google-cloud/firestore', 'knex',
    'prisma', '@prisma/client', 'typeorm', 'sequelize', 'mysql', 'mysql2', 'drizzle-orm'];
  const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
  assert.deepEqual(FORBIDDEN.filter((d) => d in deps), [], 'package.json tem driver de banco / SDK Firestore');
  const lockPath = W('package-lock.json');
  assert.ok(fs.existsSync(lockPath), 'package-lock.json ausente (pacote npm)');
  const lockRoot = readJson(lockPath).packages?.[''] ?? {};
  const lockDeps = { ...lockRoot.dependencies, ...lockRoot.devDependencies };
  assert.deepEqual(FORBIDDEN.filter((d) => d in lockDeps), [], 'package-lock.json raiz tem driver de banco');

  const sources = walk(W('src'), (p) => /\.(ts|mts|js|mjs)$/.test(p) && !/\.test\.(ts|mts|js|mjs)$/.test(p));
  assert.ok(sources.length > 0, 'services/debate-worker/src sem código');
  const importRe = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
  const offenders = [];
  let apiRefs = 0;
  for (const file of sources) {
    const rel = path.relative(ROOT, file);
    const text = fs.readFileSync(file, 'utf8');
    for (const [, spec] of text.matchAll(importRe)) {
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (FORBIDDEN.includes(name)) offenders.push(`${rel}: import ${spec}`);
    }
    for (const m of text.matchAll(/\/api\/v1(\/[A-Za-z_-]*)?/g)) {
      apiRefs++;
      if (m[1] !== '/internal') offenders.push(`${rel}: URL da API fora de /api/v1/internal (${m[0]})`);
    }
    if (/DATABASE_URL|postgres(?:ql)?:\/\/|firestore\.googleapis\.com/.test(text)) offenders.push(`${rel}: referência a banco`);
  }
  assert.deepEqual(offenders, [], 'o worker não pode ter credencial/acesso de banco');
  assert.ok(apiRefs > 0, 'o cliente da API deve montar URLs sob /api/v1/internal/');

  const envExample = W('.env.example');
  assert.ok(fs.existsSync(envExample), '.env.example ausente');
  const envText = fs.readFileSync(envExample, 'utf8');
  assert.doesNotMatch(envText, /DATABASE_URL|PG(HOST|PASSWORD|USER)|FIRESTORE/i, '.env.example sem variáveis de banco');
  for (const v of ['FLUXO_API_BASE_URL', 'FLUXO_API_AUDIENCE', 'DEBATE_ID', 'DEBATE_AUDIO_BUCKET', 'SONIOX_API_KEY', 'SONIOX_MODEL', 'WORKER_IMPERSONATE_SA']) {
    assert.match(envText, new RegExp(`^${v}=`, 'm'), `.env.example deve declarar ${v}`);
  }
  runVitestMarkers(['DV-003 NO-DB-CREDENTIALS']);
});

// ── domínio e tooling ────────────────────────────────────────────────────────

test('DV-003 enums-mirror: debate-enums.ts espelha AudioSourceKind e UtteranceOrigin de DebateEnums.cs em snake_case', async () => {
  const file = W('src/domain/debate-enums.ts');
  assert.ok(fs.existsSync(file), 'services/debate-worker/src/domain/debate-enums.ts ausente');
  const ts = fs.readFileSync(file, 'utf8');
  const cs = fs.readFileSync(path.join(ROOT, 'backend/src/Fluxo.Api/Modules/Debates/DebateEnums.cs'), 'utf8');
  const snake = (n) => n.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  for (const name of ['AudioSourceKind', 'UtteranceOrigin']) {
    const members = cs.match(new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`))?.[1].split(',').map((s) => s.trim()).filter(Boolean);
    assert.ok(members?.length, `${name} ausente em DebateEnums.cs`);
    const decl = ts.match(new RegExp(`\\b${name}\\b[\\s\\S]*?(?:;|\\n\\n)`))?.[0];
    assert.ok(decl, `${name} não declarado em debate-enums.ts`);
    const literals = new Set([...decl.matchAll(/['"]([a-z_]+)['"]/g)].map((m) => m[1]));
    for (const m of members) assert.ok(literals.has(snake(m)), `${name}: valor wire "${snake(m)}" ausente no espelho TS`);
  }
  const regras = await import(pathToFileURL(path.join(ROOT, '.claude/hooks/lib/regras.mjs')).href);
  for (const name of ['AudioSourceKind', 'UtteranceOrigin']) {
    assert.ok((regras.CANONICAL_ENUMS[name] ?? []).includes('services/debate-worker/src/domain/debate-enums.ts'),
      `${name} registrado em CANONICAL_ENUMS com o espelho do worker`);
  }
});

test('DV-003 quality-integration: pacote npm com scripts/tooling, camada debate-worker, webRoutine, diffCoverage, typecheck/lint/build verdes', async () => {
  requireWorkerDeps();
  const pkg = readJson(W('package.json'));
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.private, true);
  assert.match(pkg.engines?.node ?? '', />=\s*22/);
  for (const s of ['build', 'typecheck', 'lint', 'test', 'debate:replay', 'start']) assert.ok(pkg.scripts?.[s], `script ${s} ausente`);
  assert.match(pkg.scripts['debate:replay'], /src\/cli\.ts\s+replay/);
  assert.match(pkg.scripts.start, /node\s+dist\/index\.js/);
  for (const d of ['ws', 'google-auth-library', '@google-cloud/storage', 'zod']) assert.ok(pkg.dependencies?.[d], `dependência ${d} ausente`);
  for (const f of ['tsconfig.json', 'eslint.config.js', 'vitest.config.ts', 'esbuild.config.mjs', 'README.md', '.env.example', 'package-lock.json']) {
    assert.ok(fs.existsSync(W(f)), `services/debate-worker/${f} ausente`);
  }
  assert.ok(!fs.existsSync(path.join(ROOT, 'OCR_webscraper_crawler/pnpm-workspace.yaml'))
    || !/services\/debate-worker/.test(fs.readFileSync(path.join(ROOT, 'OCR_webscraper_crawler/pnpm-workspace.yaml'), 'utf8')),
  'o worker não entra no workspace pnpm do OCR');

  const layersCfg = readJson(path.join(ROOT, 'quality/config/layers.json')).layers;
  const iWorker = layersCfg.findIndex((l) => l.id === 'debate-worker');
  const iDocs = layersCfg.findIndex((l) => l.id === 'docs');
  assert.ok(iWorker >= 0 && iWorker < iDocs, 'camada debate-worker antes de docs em layers.json');
  assert.equal(layersCfg[iWorker].doc, 'services/debate-worker/README.md');
  const { layerOf } = await import(pathToFileURL(path.join(ROOT, 'quality/lib/layers.mjs')).href);
  for (const f of ['services/debate-worker/src/index.ts', 'services/debate-worker/README.md', 'services/debate-worker/package.json']) {
    assert.equal(layerOf(f).id, 'debate-worker', `${f} deve cair na camada debate-worker`);
  }
  const tsRunner = fs.readFileSync(path.join(ROOT, 'quality/lib/runners/typescript.mjs'), 'utf8');
  const loop = tsRunner.match(/export function webRoutine[\s\S]*?for \(const app of \[([^\]]*)\]/)?.[1] ?? '';
  assert.match(loop, /['"]services\/debate-worker['"]/, 'webRoutine percorre services/debate-worker');
  const tiers = fs.readFileSync(path.join(ROOT, 'quality/lib/tiers.mjs'), 'utf8');
  assert.match(tiers, /byLayer\.has\(['"]debate-worker['"]\)[^\n]*webRoutine|webRoutine[^\n]*debate-worker/, 'tiers.mjs dispara webRoutine com a camada debate-worker');
  const thresholds = readJson(path.join(ROOT, 'quality/config/thresholds.json'));
  assert.ok(Number(thresholds.diffCoverage?.['debate-worker']) >= 80, 'diffCoverage["debate-worker"] definido (proposta 85)');

  runOk('npm', ['--prefix', WORKER, 'run', '--silent', 'typecheck'], { label: 'typecheck', timeout: 40_000 });
  runOk('npm', ['--prefix', WORKER, 'run', '--silent', 'lint'], { label: 'lint', timeout: 40_000 });
  fs.rmSync(W('dist'), { recursive: true, force: true });
  runOk('npm', ['--prefix', WORKER, 'run', '--silent', 'build'], { label: 'build', timeout: 30_000 });
  const bundle = fs.readFileSync(W('dist/index.js'), 'utf8');
  assert.match(bundle, /createRequire/, 'bundle ESM com banner createRequire');
  assert.match(bundle, /from\s*["']google-auth-library["']|import\(["']google-auth-library["']\)/, 'google-auth-library fica external no bundle');
});
