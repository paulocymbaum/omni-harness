import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { repoRoot } from '../lib/util.mjs';

const root = repoRoot();
const cli = path.join(root, 'scripts', 'deploy', 'actions-quota.mjs');

/** gh falso: responde por argumentos; FAKE_USERS/FAKE_ORGS=erro simula 403, FAKE_USED/FAKE_INCLUDED mudam o saldo. */
const criarShim = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'quota-shim-'));
  const bin = path.join(dir, 'gh');
  writeFileSync(bin, `#!/bin/sh
case "$*" in
  *repo*view*) echo '{"owner":{"login":"acme"}}' ;;
  *"api users/acme"*)
    [ "$FAKE_USERS" = "erro" ] && exit 1
    echo "{\\"total_minutes_used\\": \${FAKE_USED:-100}, \\"included_minutes\\": \${FAKE_INCLUDED:-2000}}" ;;
  *"api orgs/acme"*)
    [ "$FAKE_ORGS" = "ok" ] || exit 1
    echo "{\\"total_minutes_used\\": \${FAKE_USED:-100}, \\"included_minutes\\": \${FAKE_INCLUDED:-2000}}" ;;
esac
`, { mode: 0o755 });
  return { bin, limpar: () => rmSync(dir, { recursive: true, force: true }) };
};

const rodar = (bin, env = {}) => spawnSync(process.execPath, [cli, '--check'], {
  cwd: root, encoding: 'utf8', env: { ...process.env, FLUXO_GH: bin, ...env },
});

test('billing com saldo → exit 0 e veredito de crédito', () => {
  const { bin, limpar } = criarShim();
  try {
    const r = rodar(bin, { FAKE_USED: '100', FAKE_INCLUDED: '2000' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /COM CRÉDITO/);
  } finally { limpar(); }
});

test('billing esgotado → exit 1 e instrução de script local', () => {
  const { bin, limpar } = criarShim();
  try {
    const r = rodar(bin, { FAKE_USED: '2000', FAKE_INCLUDED: '2000' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /SEM SALDO/);
    assert.match(r.stdout, /--local/);
  } finally { limpar(); }
});

test('billing esgotado com used > included → exit 1', () => {
  const { bin, limpar } = criarShim();
  try {
    const r = rodar(bin, { FAKE_USED: '2100', FAKE_INCLUDED: '2000' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /SEM SALDO/);
  } finally { limpar(); }
});

test('billing 403 em user e org → inconclusivo (exit 1, dispatch decide no --run)', () => {
  const { bin, limpar } = criarShim();
  try {
    const r = rodar(bin, { FAKE_USERS: 'erro' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /INCONCLUSIVO/);
  } finally { limpar(); }
});

test('included_minutes = 0 → inconclusivo (não separa overage de esgotado)', () => {
  const { bin, limpar } = criarShim();
  try {
    const r = rodar(bin, { FAKE_INCLUDED: '0', FAKE_USED: '0' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /INCONCLUSIVO/);
  } finally { limpar(); }
});

test('fallback para endpoint de org quando user não existe', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'quota-shim-'));
  const bin = path.join(dir, 'gh');
  writeFileSync(bin, `#!/bin/sh
case "$*" in
  *repo*view*) echo '{"owner":{"login":"acme"}}' ;;
  *"api users/acme"*) exit 1 ;;
  *"api orgs/acme"*) echo '{"total_minutes_used": 10, "included_minutes": 3000}' ;;
esac
`, { mode: 0o755 });
  try {
    const r = rodar(bin);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /COM CRÉDITO/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
