import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backendTestEnvironment } from '../lib/runners/backend-env.mjs';

function withConfig(config, action) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-env-'));
  try {
    if (config) fs.writeFileSync(path.join(root, 'firebase.json'), JSON.stringify(config));
    action(root);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const local = { emulators: { firestore: { host: '127.0.0.1', port: 8081 }, hub: { port: 4401 } } };

test('backend: variável explícita prevalece e não consulta o hub', () => {
  const env = { FIRESTORE_EMULATOR_HOST: 'localhost:8181' };
  assert.deepEqual(backendTestEnvironment({ env, probe: () => assert.fail('não consultar hub') }), env);
});

test('backend: descobre somente o Firestore local anunciado pelo hub configurado', () => {
  withConfig(local, (root) => {
    const probe = (url) => {
      assert.equal(url, 'http://127.0.0.1:4401/emulators');
      return { host: 'localhost', port: 8081 };
    };
    assert.deepEqual(backendTestEnvironment({ root, env: {}, probe }), { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8081' });
  });
});

test('backend: ausência, serviço parado ou porta diferente não inventam emulador', () => {
  withConfig(null, (root) => assert.equal(backendTestEnvironment({ root, env: {}, probe: () => assert.fail('sem config') }), undefined));
  withConfig(local, (root) => {
    for (const running of [null, {}, { port: 8081 }, { host: '127.0.0.1', port: 8080 }, { host: 'remote.example', port: 8081 }]) {
      assert.equal(backendTestEnvironment({ root, env: {}, probe: () => running }), undefined);
    }
  });
});

test('backend: configuração remota ou inválida não gera chamada de rede', () => {
  for (const emulators of [
    { firestore: { host: 'remote.example', port: 8081 } },
    { firestore: { port: -1 } },
    { firestore: { port: 8081 }, hub: { host: 'remote.example' } },
    { firestore: { port: 8081 }, hub: { port: '4401' } },
  ]) {
    withConfig({ emulators }, (root) => {
      assert.equal(backendTestEnvironment({ root, env: {}, probe: () => assert.fail('não consultar rede') }), undefined);
    });
  }
});
