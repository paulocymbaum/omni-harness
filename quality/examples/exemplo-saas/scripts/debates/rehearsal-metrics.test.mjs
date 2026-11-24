import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { measureRehearsal, normalizeLogs, parseArgs } from './rehearsal-metrics.mjs';

const base = Date.parse('2026-10-22T19:00:00Z');
const iso = (seconds) => new Date(base + seconds * 1000).toISOString();
const change = (kind, id, display, speech = 0) => ({ kind, id, display, speech_end_at: iso(speech) });
const pub = (version, at, changes, balloons = 0) => ({ jsonPayload: { event: 'debate.timeline.published',
  debate_id: 'debate-a', version, generated_at: iso(at), pending: 0, balloons, cards: 0, changes: JSON.stringify(changes) } });
const serve = (version, at, instance = 'a') => ({ jsonPayload: { event: 'debate.timeline.served',
  debate_id: 'debate-a', version, served_at: iso(at), instance } });
const action = (id, target, at, kind = 'not_validate') => ({ id, debateId: 'debate-a', targetType: 'fact_check',
  targetId: target, action: kind, createdAt: iso(at) });

function fixture() {
  return [pub(1, 1, [change('utterance', 'u1', 'card')]),
    pub(2, 4, [change('claim', 'c1', 'pending')]),
    pub(3, 10, [change('claim', 'c1', 'balloon'), change('check', 'f1', 'balloon')], 1),
    pub(4, 15, [change('utterance', 'u2', 'card', 12)] , 1),
    serve(2, 5, 'slow'), serve(4, 16, 'fast'), serve(1, 7, 'slow'),
    pub(5, 20, [change('claim', 'c1', 'absent'), change('check', 'f1', 'absent')]), serve(6, 24)];
}

test('speech uses earliest served version >= appearance; pending/balloon first publication; no check double count', () => {
  const result = measureRehearsal(fixture(), { actions: [action('a1', 'f1', 18)] });
  assert.deepEqual(result.metrics, {
    utterance_to_timeline_s: { samples: 2, median: 7, p95: 7.5 },
    claim_pending_s: { samples: 1, median: 6.5, p95: 6.5, max: 6.5 },
    balloon_s: { samples: 1, median: 10, p95: 10, max: 10 },
    retraction_s: { samples: 1, max: 6 }, client_poll_allowance_s: 2.5,
  });
});

test('order and duplicate Cloud Logging publication exports do not affect metrics', () => {
  const logs = fixture();
  assert.deepEqual(measureRehearsal([...logs].reverse().concat(logs[0])), measureRehearsal(logs));
  assert.throws(() => measureRehearsal([...logs, pub(1, 2, [])]), /Conflicting publication/);
});

test('window chooses speech/action cohort, retaining later observations after to', () => {
  const result = measureRehearsal(fixture(), { segment: 'url', from: iso(11), to: iso(19),
    actions: [action('a1', 'f1', 18), action('a2', 'f2', 19)] });
  assert.equal(result.segment, 'url');
  assert.deepEqual(result.metrics.utterance_to_timeline_s, { samples: 1, median: 6.5, p95: 6.5 });
  assert.equal(result.metrics.claim_pending_s.samples, 0);
  assert.deepEqual(result.metrics.retraction_s, { samples: 1, max: 6 });
});

test('expiration counts checks that were balloons, never both claim and check disappearance', () => {
  const result = measureRehearsal(fixture(), { endedAt: iso(19) });
  assert.deepEqual(result.expiration, { balloons_before_end: 1, expired_at_end: 1, balloons_after_end: 0 });
  const reappears = [...fixture(), pub(7, 25, [change('check', 'f2', 'balloon')], 1)];
  assert.equal(measureRehearsal(reappears, { endedAt: iso(19) }).expiration.balloons_after_end, 1);
  assert.throws(() => measureRehearsal(fixture(), { endedAt: iso(99) }), /before and after/);
});

test('retraction requires observed absence, excludes reappearance and reports missing action evidence', () => {
  const logs = [...fixture().filter((r) => r.jsonPayload.version !== 6),
    pub(6, 21, [change('check', 'f1', 'balloon')], 1), serve(6, 24)];
  const result = measureRehearsal(logs, { actions: [action('a1', 'f1', 18, 'unpublish'), action('a2', 'missing', 19)] });
  assert.deepEqual(result.metrics.retraction_s, { samples: 0, max: null });
  assert.equal(result.diagnostics.unmatched_retraction_actions, 2);
});

test('missing observations are not invented as zero latency', () => {
  const logs = [pub(1, 1, [change('utterance', 'u1', 'card'),
    { kind: 'claim', id: 'c1', display: 'pending', speech_end_at: null }])];
  const result = measureRehearsal(logs);
  assert.deepEqual(result.metrics.utterance_to_timeline_s, { samples: 0, median: null, p95: null });
  assert.equal(result.diagnostics.missing_served, 1);
  assert.equal(result.diagnostics.missing_speech_end, 1);
  assert.equal(result.diagnostics.actions_supplied, false);
});

test('supports direct fields, JsonConsole State and real rendered LogInformation textPayload', () => {
  const changes = [change('utterance', 'u1', 'card')];
  const direct = pub(1, 1, changes).jsonPayload;
  const state = { jsonPayload: { State: { ...direct, event: undefined,
    '{OriginalFormat}': 'debate.timeline.published {debate_id} {version} {generated_at} {pending} {balloons} {cards} {changes}' } } };
  const rendered = { textPayload: `info: handler[0]\n      debate.timeline.published debate-a 1 ${iso(1)} 0 0 0 ${JSON.stringify(changes)}` };
  const served = { textPayload: `debate.timeline.served debate-a 2 10/22/2026 19:00:05 +00:00 revision/host` };
  assert.deepEqual(normalizeLogs([state]), normalizeLogs([direct]));
  assert.deepEqual(normalizeLogs([rendered]), normalizeLogs([direct]));
  assert.equal(measureRehearsal([rendered, served]).metrics.utterance_to_timeline_s.median, 7.5);
});

test('validates required fields, JSON, date timezone, version, options and unambiguous debate', () => {
  assert.throws(() => measureRehearsal({}), /array/);
  assert.throws(() => measureRehearsal([]), /one debate/);
  assert.throws(() => measureRehearsal(fixture(), { from: iso(10), to: iso(1) }), /after from/);
  assert.throws(() => measureRehearsal(fixture(), { from: '2026-10-22T19:00:00' }), /timezone/);
  assert.throws(() => measureRehearsal(fixture(), { segment: 'invalid' }), /segment/);
  assert.throws(() => normalizeLogs([{ ...pub(1, 1, []), jsonPayload: { ...pub(1, 1, []).jsonPayload, changes: '[' } }]), /changes JSON/);
  assert.throws(() => normalizeLogs([{ event: 'debate.timeline.served', debate_id: 'a', version: -1 }]), /version/);
  const other = { ...pub(1, 1, []).jsonPayload, debate_id: 'debate-b' };
  assert.throws(() => measureRehearsal([...fixture(), other]), /one debate/);
  assert.equal(measureRehearsal([...fixture(), other], { debateId: 'debate-a' }).debate_id, 'debate-a');
  assert.throws(() => parseArgs(['logs.json', '--unknown', 'x']), /Invalid option/);
  assert.throws(() => parseArgs(['logs.json', '--from']), /Invalid option/);
});

test('CLI reads logs/actions offline and emits only JSON on stdout, errors exit nonzero', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fluxo-metrics-'));
  try {
    const logs = path.join(dir, 'logs.json');
    const actions = path.join(dir, 'actions.json');
    writeFileSync(logs, JSON.stringify(fixture()));
    writeFileSync(actions, JSON.stringify([action('a1', 'f1', 18)]));
    const result = spawnSync(process.execPath, ['scripts/debates/rehearsal-metrics.mjs', logs,
      '--actions', actions, '--ended-at', iso(19), '--segment', 'replay'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).metrics.retraction_s.samples, 1);
    const invalid = spawnSync(process.execPath, ['scripts/debates/rehearsal-metrics.mjs', logs, '--unknown'], { encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
