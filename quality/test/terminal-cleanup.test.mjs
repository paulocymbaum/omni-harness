// Gate da limpeza de terminais do Cline: seleção PURA sobre saída de `ps` sintética.
// Regras: shell filho de ptyhost com >1 h e SEM filho vivo = alvo; jovem, ocupado,
// whitelist e não-shell nunca morrem. Falha aberta no main (nunca lança, stdout vazio).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selecionarAlvos } from '../hooks/cline-terminal-cleanup.mjs';

const PS = [
  '  100     1  90000 /usr/share/code/code --type=ptyhost',
  '  200   100   200 /bin/zsh',
  '  201   100  1800 /usr/bin/bash',
  '  202   100  5400 /bin/zsh',
  '  203   100  7200 /usr/bin/fish',
  '  204   203     5 /usr/bin/top',
  '  205   100  8000 /bin/bash --login',
  '  206   100  8000 node server.js',
  '  207     1  90000 /bin/zsh',
];

test('alvo = shell filho de ptyhost com >1h e sem filho; jovem/ocupado/não-shell fora', () => {
  assert.deepEqual(selecionarAlvos(PS), [202, 205]);
});

test('whitelist (CLINE_KEEP_TERMINAL_PIDS) preserva o terminal do dono', () => {
  assert.deepEqual(selecionarAlvos(PS, { manter: [205] }), [202]);
});

test('shell sem ptyhost como pai nunca é alvo (fora do VS Code)', () => {
  const fora = selecionarAlvos(PS).includes(207);
  assert.equal(fora, false);
});

test('limite de idade: 1 h exata não morre (etimes <= 3600)', () => {
  const limite = [...PS, '  208   100  3600 /bin/zsh'];
  assert.deepEqual(selecionarAlvos(limite), [202, 205]);
});
