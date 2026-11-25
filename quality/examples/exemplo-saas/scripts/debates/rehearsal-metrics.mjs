#!/usr/bin/env node
// Offline DV-010 telemetry reduction. Never calls the API or creates rehearsal evidence.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CLIENT_POLL_ALLOWANCE_S = 2.5;
const PREFIX = 'debate.timeline.';
const fail = (message) => { throw new Error(message); };
const integer = (value, field) => {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(n) && n >= 0 ? n : fail(`Invalid ${field}: expected nonnegative safe integer`);
};
const identifier = (value, field) => typeof value === 'string' && value.trim() ? value : fail(`Missing ${field}`);
const instant = (value, field, rendered = false) => {
  if (typeof value !== 'string' || (!rendered && !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)))
    fail(`Invalid ${field}: expected timestamp with timezone`);
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : fail(`Invalid ${field}`);
};
const list = (value, field) => Array.isArray(value) ? value : fail(`Invalid ${field}: expected JSON array`);

function renderedEvent(message) {
  if (typeof message !== 'string') return null;
  const event = message.match(/debate\.timeline\.(published|served)\s+(\S+)\s+(\d+)\s+([^\n]+)/);
  if (!event) return null;
  const [, kind, debate_id, version, rest] = event;
  if (kind === 'published') {
    const fields = rest.match(/^(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\[.*\])\s*$/);
    if (!fields) fail('Malformed published textPayload');
    const [, generated_at, pending, balloons, cards, changes] = fields;
    return { event: PREFIX + kind, debate_id, version, generated_at, pending, balloons, cards, changes, rendered: true };
  }
  const fields = rest.match(/^(.+?)\s+(\S+)\s*$/);
  if (!fields) fail('Malformed served textPayload');
  return { event: PREFIX + kind, debate_id, version, served_at: fields[1], instance: fields[2], rendered: true };
}

function payload(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail('Invalid log entry');
  const outer = row.jsonPayload ?? row;
  const fields = outer.State ?? outer.state ?? outer;
  const message = outer.Message ?? outer.message ?? row.textPayload;
  const event = fields.event ?? fields['{OriginalFormat}'];
  if (typeof event === 'string' && event.startsWith(PREFIX)) return { ...fields, event: event.split(' ')[0] };
  return renderedEvent(message);
}

function normalizeChange(change) {
  const kind = identifier(change?.kind, 'changes.kind');
  if (!['utterance', 'claim', 'check'].includes(kind)) fail('Invalid changes.kind');
  const display = identifier(change.display, 'changes.display');
  if (!['pending', 'balloon', 'card', 'absent'].includes(display)) fail('Invalid changes.display');
  return { kind, id: identifier(change.id, 'changes.id'), display,
    speechEnd: change.speech_end_at == null ? null : instant(change.speech_end_at, 'speech_end_at') };
}

export function normalizeLogs(raw) {
  return list(raw, 'logs').flatMap((row) => {
    const p = payload(row);
    if (!p || ![PREFIX + 'published', PREFIX + 'served'].includes(p.event)) return [];
    const common = { debateId: identifier(p.debate_id, 'debate_id'), version: integer(p.version, 'version') };
    if (p.event.endsWith('served')) return [{ ...common, kind: 'served',
      at: instant(p.served_at, 'served_at', p.rendered), instance: identifier(p.instance, 'instance') }];
    let changes = p.changes;
    if (typeof changes === 'string') {
      try { changes = JSON.parse(changes); } catch { fail('Invalid changes JSON'); }
    }
    return [{ ...common, kind: 'published', at: instant(p.generated_at, 'generated_at', p.rendered),
      pending: integer(p.pending, 'pending'), balloons: integer(p.balloons, 'balloons'), cards: integer(p.cards, 'cards'),
      changes: list(changes, 'changes').map(normalizeChange) }];
  });
}

function normalizeActions(raw) {
  return list(raw, 'actions').flatMap((a) => {
    const type = a?.action;
    if (!['not_validate', 'unpublish'].includes(type)) return [];
    const targetType = a.target_type ?? a.targetType;
    if (targetType !== 'fact_check') fail('Retraction action must target fact_check');
    return [{ id: identifier(a.id, 'action.id'), debateId: identifier(a.debate_id ?? a.debateId, 'action.debate_id'),
      targetId: identifier(a.target_id ?? a.targetId, 'action.target_id'),
      at: instant(a.created_at ?? a.createdAt, 'action.created_at') }];
  });
}

function uniquePublications(rows) {
  const byVersion = new Map();
  for (const row of rows.filter((r) => r.kind === 'published')) {
    const before = byVersion.get(row.version);
    if (before && JSON.stringify(before) !== JSON.stringify(row)) fail(`Conflicting publication version ${row.version}`);
    byVersion.set(row.version, row);
  }
  return [...byVersion.values()].sort((a, b) => a.version - b.version);
}

function stats(samples, maximum = false) {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const median = n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null;
  return { samples: n, median, p95: n ? sorted[Math.ceil(n * 0.95) - 1] : null,
    ...(maximum ? { max: n ? sorted[n - 1] : null } : {}) };
}

const entityKey = (change) => `${change.kind}:${change.id}`;
function collectFirst(publications) {
  const seen = new Set();
  return publications.flatMap((publication) => publication.changes.flatMap((change) => {
    const key = `${entityKey(change)}:${change.display}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...change, at: publication.at, version: publication.version }];
  }));
}
function servedAfter(serves, publication, earliest, visible) {
  return serves.find((s) => s.version >= publication.version && s.at >= publication.at && s.at >= earliest && (!visible || visible(s)));
}
function latencySamples(first, serves, within) {
  const result = { utterance: [], pending: [], balloon: [], missingServed: 0, missingSpeechEnd: 0 };
  for (const item of first) {
    const group = item.kind === 'utterance' && item.display === 'card' ? 'utterance'
      : item.kind === 'claim' && item.display === 'pending' ? 'pending'
        : item.kind === 'check' && item.display === 'balloon' ? 'balloon' : null;
    if (!group) continue;
    if (item.speechEnd === null) { result.missingSpeechEnd++; continue; }
    if (!within(item.speechEnd)) continue;
    const served = group === 'utterance' ? servedAfter(serves, item, item.speechEnd) : item;
    if (!served) { result.missingServed++; continue; }
    if (served.at < item.speechEnd) fail('Publication precedes speech_end_at');
    result[group].push((served.at - item.speechEnd) / 1000 + (group === 'balloon' ? 0 : CLIENT_POLL_ALLOWANCE_S));
  }
  return result;
}

function retractions(actions, publications, serves) {
  const latencies = [];
  let unmatched = 0;
  for (const action of actions) {
    const removed = publications.find((p) => p.at >= action.at && p.changes.some((c) =>
      c.kind === 'check' && c.id === action.targetId && c.display === 'absent'));
    const absentAt = (served) => {
      const last = publications.filter((p) => p.version <= served.version).flatMap((p) => p.changes)
        .filter((c) => c.kind === 'check' && c.id === action.targetId).at(-1);
      return last?.display === 'absent';
    };
    const observed = removed && servedAfter(serves, removed, action.at, absentAt);
    if (observed) latencies.push((observed.at - action.at) / 1000);
    else unmatched++;
  }
  return { samples: latencies.length, max: latencies.length ? Math.max(...latencies) : null, unmatched };
}

function expiration(publications, endedAt) {
  if (!endedAt) return null;
  const before = publications.filter((p) => p.at < endedAt).at(-1);
  const after = publications.filter((p) => p.at >= endedAt);
  if (!before || !after.length) fail('Expiration needs publications before and after ended_at');
  const visible = new Map();
  for (const p of publications.filter((p) => p.version <= before.version))
    for (const change of p.changes) visible.set(entityKey(change), change.display);
  const removed = after[0].changes.filter((c) => c.kind === 'check' && c.display === 'absent' &&
    visible.get(entityKey(c)) === 'balloon');
  return { balloons_before_end: before.balloons, expired_at_end: new Set(removed.map((c) => c.id)).size,
    balloons_after_end: Math.max(...after.map((p) => p.balloons)) };
}

export function measureRehearsal(raw, options = {}) {
  const from = options.from == null ? -Infinity : instant(options.from, 'from');
  const to = options.to == null ? Infinity : instant(options.to, 'to');
  if (to <= from) fail('to must be after from');
  if (options.segment != null && !['replay', 'url'].includes(options.segment)) fail('segment must be replay or url');
  const normalized = normalizeLogs(raw);
  const ids = new Set(normalized.map((r) => r.debateId));
  const debateId = options.debateId ?? (ids.size === 1 ? [...ids][0] : fail('Logs must identify one debate; use --debate-id'));
  const rows = normalized.filter((r) => r.debateId === debateId);
  if (!rows.length) fail('No timeline telemetry for requested debate');
  const publications = uniquePublications(rows);
  if (!publications.length) fail('No published timeline telemetry');
  const serves = rows.filter((r) => r.kind === 'served').sort((a, b) => a.at - b.at || a.version - b.version);
  const within = (at) => at >= from && at < to;
  const sample = latencySamples(collectFirst(publications), serves, within);
  const actions = normalizeActions(options.actions ?? []).filter((a) => a.debateId === debateId && within(a.at));
  const removed = retractions(actions, publications, serves);
  return { debate_id: debateId, segment: options.segment ?? null,
    metrics: { utterance_to_timeline_s: stats(sample.utterance), claim_pending_s: stats(sample.pending, true),
      balloon_s: stats(sample.balloon, true), retraction_s: { samples: removed.samples, max: removed.max },
      client_poll_allowance_s: CLIENT_POLL_ALLOWANCE_S },
    expiration: expiration(publications, options.endedAt == null ? null : instant(options.endedAt, 'ended_at')),
    diagnostics: { missing_served: sample.missingServed, missing_speech_end: sample.missingSpeechEnd,
      unmatched_retraction_actions: removed.unmatched, actions_supplied: options.actions != null,
      publication_versions: publications.length, served_observations: serves.length } };
}

export function parseArgs(args) {
  const [file, ...rest] = args;
  if (!file || file.startsWith('--')) fail('Usage: rehearsal-metrics.mjs logs.json [--segment replay|url --from ISO --to ISO --actions actions.json --ended-at ISO --debate-id ID]');
  const names = { '--segment': 'segment', '--from': 'from', '--to': 'to', '--actions': 'actionsFile',
    '--ended-at': 'endedAt', '--debate-id': 'debateId' };
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = names[rest[i]];
    if (!name || options[name] !== undefined || !rest[i + 1] || rest[i + 1].startsWith('--')) fail(`Invalid option ${rest[i]}`);
    options[name] = rest[i + 1];
  }
  return { file, options };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { file, options } = parseArgs(process.argv.slice(2));
    const actions = options.actionsFile ? JSON.parse(fs.readFileSync(options.actionsFile, 'utf8')) : undefined;
    console.log(JSON.stringify(measureRehearsal(JSON.parse(fs.readFileSync(file, 'utf8')), { ...options, actions }), null, 2));
  } catch (error) { console.error(`rehearsal-metrics: ${error.message}`); process.exitCode = 1; }
}
