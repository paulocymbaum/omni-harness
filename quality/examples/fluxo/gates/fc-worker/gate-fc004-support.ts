// Apoio dos gates FC-004 no worker (template; copiado para services/creator-worker/src/ só durante o gate).
// Cada arquivo de teste cria um banco descartável no PostgreSQL de teste (FLUXO_TEST_POSTGRES, formato Npgsql), com o
// mínimo que o SQL do contrato exige (fluxo.businesses e o histórico) e aplica backend/deploy/sql/creator-jobs.sql.
// Sem a variável, FALHA. Nada aqui conhece o interior do worker além de loadConfig(env).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { loadConfig } from './config.js';

export const KIND_LANE: Record<string, 'llm' | 'render'> = {
  strategy: 'llm', slide_copy: 'llm', vision: 'llm', render: 'render', preview: 'render', adapt_viewport: 'render',
};

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function until(check: () => Promise<boolean> | boolean, timeoutMs = 10_000, stepMs = 40): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(stepMs);
  }
  throw new Error(`condição não atendida em ${timeoutMs} ms`);
}

function npgsql(connection: string): { host: string; port: number; database: string; user: string; password: string } {
  const parts = Object.fromEntries(connection.split(';').filter(Boolean).map((kv) => {
    const at = kv.indexOf('=');
    return [kv.slice(0, at).trim().toLowerCase(), kv.slice(at + 1).trim()];
  }));
  return { host: parts.host, port: Number(parts.port ?? 5432), database: parts.database, user: parts.username ?? parts.user, password: parts.password };
}

export type TestDb = { pool: pg.Pool; url: string; reset: () => Promise<void>; close: () => Promise<void> };

export async function createDb(): Promise<TestDb> {
  const raw = process.env.FLUXO_TEST_POSTGRES;
  if (!raw?.trim()) throw new Error('FLUXO_TEST_POSTGRES não configurado (PostgreSQL de teste); o gate falha em vez de pular');
  const c = npgsql(raw);
  const base = `postgres://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}`;
  const name = `fcw_${randomUUID().replace(/-/g, '')}`.slice(0, 40);
  const admin = new pg.Client({ connectionString: `${base}/postgres` });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  const url = `${base}/${name}`;
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  await pool.query(`
    CREATE SCHEMA fluxo;
    CREATE TABLE fluxo.businesses (id character varying(128) NOT NULL PRIMARY KEY);
    CREATE TABLE fluxo."__EFMigrationsHistory" ("MigrationId" character varying(150) NOT NULL PRIMARY KEY, "ProductVersion" character varying(32) NOT NULL);`);
  const sql = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../backend/deploy/sql/creator-jobs.sql'), 'utf8');
  await pool.query(sql);
  return {
    pool, url,
    // Isolamento por teste (FC-004 D2): os testes de uma suíte compartilham o banco, e job queued/running deixado por um teste
    // seria retirado no seguinte. Zera só creator_jobs (businesses ficam: cada teste cria as suas contas).
    reset: async () => { await pool.query('DELETE FROM fluxo.creator_jobs'); },
    close: async () => {
      await pool.end();
      const cleaner = new pg.Client({ connectionString: `${base}/postgres` });
      await cleaner.connect();
      await cleaner.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await cleaner.end();
    },
  };
}

/** Config real do worker, só com a URL e esperas curtas; o resto vem de loadConfig (padrões da spec) ou das variáveis passadas. */
export function cfg(url: string, overrides: Record<string, string> = {}) {
  return loadConfig({ CREATOR_DATABASE_URL: url, CREATOR_POLL_MIN_MS: '30', CREATOR_POLL_MAX_MS: '100', ...overrides });
}

export async function addBusiness(pool: pg.Pool): Promise<string> {
  const id = `biz-${randomUUID().replace(/-/g, '')}`;
  await pool.query('INSERT INTO fluxo.businesses (id) VALUES ($1)', [id]);
  return id;
}

export type NewJob = {
  business: string; kind?: string; priority?: number; ageSeconds?: number; runAfterInSeconds?: number; expiresInSeconds?: number;
  maxAttempts?: number; deadlineSeconds?: number; payload?: unknown;
};

export async function insertJob(pool: pg.Pool, job: NewJob): Promise<string> {
  const kind = job.kind ?? 'strategy';
  const result = await pool.query(
    `INSERT INTO fluxo.creator_jobs (business_id, project_id, kind, lane, priority, deadline_seconds, max_attempts, expires_at, run_after, created_at, idempotency_key, payload)
     VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, $6, now() + make_interval(secs => $7), now() + make_interval(secs => $8), now() - make_interval(secs => $9), $10, $11::jsonb)
     RETURNING id`,
    [job.business, kind, KIND_LANE[kind], job.priority ?? 1, job.deadlineSeconds ?? 120, job.maxAttempts ?? 3, job.expiresInSeconds ?? 900,
      job.runAfterInSeconds ?? 0, job.ageSeconds ?? 0, randomUUID(), JSON.stringify(job.payload ?? {})],
  );
  return result.rows[0].id as string;
}

export async function row(pool: pg.Pool, id: string) {
  const r = await pool.query(
    `SELECT status, attempts, max_attempts, locked_by, locked_until, error_code, result_ref, finished_at, first_started_at, deadline_at, run_after,
            extract(epoch FROM run_after - now())::float8 AS run_after_in, extract(epoch FROM locked_until - now())::float8 AS locked_until_in,
            extract(epoch FROM deadline_at - first_started_at)::float8 AS deadline_span, (run_after <= now()) AS ready
     FROM fluxo.creator_jobs WHERE id = $1`, [id]);
  return r.rows[0] as {
    status: string; attempts: number; max_attempts: number; locked_by: string | null; locked_until: Date | null; error_code: string | null; result_ref: string | null;
    finished_at: Date | null; first_started_at: Date | null; deadline_at: Date | null; run_after: Date; run_after_in: number; locked_until_in: number | null;
    deadline_span: number | null; ready: boolean;
  };
}

export async function businessOf(pool: pg.Pool, id: string): Promise<string> {
  return (await pool.query('SELECT business_id FROM fluxo.creator_jobs WHERE id = $1', [id])).rows[0].business_id as string;
}

type Queue = { claim: (lane: 'llm' | 'render', workerId: string) => Promise<{ id: string } | null> };

/** Retirada com repetição curta: o lock estrito por pista pode devolver "nada" sob disputa, e o worker tenta no próximo ciclo. */
export async function claimOne(queue: Queue, lane: 'llm' | 'render', workerId: string, tries = 25) {
  for (let i = 0; i < tries; i++) {
    const job = await queue.claim(lane, workerId);
    if (job) return job;
    await sleep(20);
  }
  return null;
}
