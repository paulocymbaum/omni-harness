// Anti-loop do run_commands (teto fuzzy companion): repetição idêntica é contada por
// sessão; a 3ª ganha variação determinística antes do detector de 5 do harness e a
// 4ª aciona o aviso de troca de estratégia. Comando diferente reseta o contador.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { registrarComando } from '../lib/anti-loop.mjs';

const estado = (dir, nome = 'anti-loop.json') =>
  JSON.parse(fs.readFileSync(path.join(dir, nome), 'utf8'));

test('primeira chamada: passa igual, sem aviso', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antiloop-'));
  const arquivo = path.join(dir, 'anti-loop.json');

  const r = registrarComando({
    stateFile: arquivo,
    sessionId: 's1',
    comando: 'sleep 25; ps -p 1',
  });

  assert.equal(r.repeticoes, 1);
  assert.equal(r.comandoFinal, 'sleep 25; ps -p 1');
  assert.equal(r.avisar, false);
  assert.equal(estado(dir).sessoes.s1.tick, 1);
});

test('3ª repetição idêntica ganha variação determinística; 4ª aciona aviso', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antiloop-'));
  const arquivo = path.join(dir, 'anti-loop.json');
  const chama = () =>
    registrarComando({ stateFile: arquivo, sessionId: 's1', comando: 'sleep 25; ps -p 1' });

  const primeira = chama();
  const segunda = chama();
  const terceira = chama();
  const quarta = chama();

  assert.equal(primeira.repeticoes, 1);
  assert.equal(primeira.avisar, false);
  assert.equal(segunda.repeticoes, 2);
  assert.equal(segunda.avisar, false);
  assert.equal(terceira.repeticoes, 3);
  assert.equal(terceira.comandoFinal, 'sleep 25; ps -p 1 # poll 3');
  assert.equal(terceira.avisar, false);
  assert.equal(quarta.comandoFinal, 'sleep 25; ps -p 1 # poll 4');
  assert.equal(quarta.avisar, true);
});

test('comando diferente reseta o contador para a nova sessão de comando', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antiloop-'));
  const arquivo = path.join(dir, 'anti-loop.json');

  const a = () =>
    registrarComando({ stateFile: arquivo, sessionId: 's1', comando: 'sleep 25; ps' });
  a();
  a();
  assert.equal(a().repeticoes, 3);

  const outro = registrarComando({
    stateFile: arquivo,
    sessionId: 's1',
    comando: 'dart analyze test',
  });
  assert.equal(outro.repeticoes, 1);
  assert.equal(outro.avisar, false);
});

test('sessões distintas não compartilham contador', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antiloop-'));
  const arquivo = path.join(dir, 'anti-loop.json');
  const cmd = 'sleep 25; ps';

  registrarComando({ stateFile: arquivo, sessionId: 'a', comando: cmd });
  const b = registrarComando({ stateFile: arquivo, sessionId: 'b', comando: cmd });

  assert.equal(b.repeticoes, 1);
});

test('comando vazio ou estado ausente não quebra', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antiloop-'));
  const r = registrarComando({
    stateFile: path.join(dir, 'anti-loop.json'),
    sessionId: 's1',
    comando: '   ',
  });
  assert.equal(r.repeticoes, 1);
  assert.equal(r.comandoFinal, '   ');
  assert.equal(registrarComando({ sessionId: 's1', comando: 'x' }).comandoFinal, 'x');
});

test('estado persiste no arquivo e poda sessões expiradas', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antiloop-'));
  const arquivo = path.join(dir, 'anti-loop.json');
  const agora = 1_700_000_000_000;

  registrarComando({
    stateFile: arquivo,
    sessionId: 'velha',
    comando: 'antigo',
    agora: agora - 7 * 60 * 60 * 1000,
  });
  registrarComando({ stateFile: arquivo, sessionId: 'nova', comando: 'novo', agora });

  const salvo = estado(dir);
  assert.equal(salvo.sessoes.velha, undefined, 'expirada podada');
  assert.equal(salvo.sessoes.nova.tick, 1);
});
