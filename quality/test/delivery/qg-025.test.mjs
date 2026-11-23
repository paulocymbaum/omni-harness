// Gate QG-025 — gitflow/bump: menos branches (reciclagem do nome da release), matriz de merge
// completa para o merge local em RELEASE e negação de push direto em RELEASE com comando de retomada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushDecision, mergeDecision } from '../../../quality/lib/gitflow.mjs';
import { uniqueReleaseBranch, estrategiaPropagacao, pendingTargets, PROPAGATE_TO } from '../../../quality/lib/release-flow.mjs';

test('reciclagem: release/x.y.z totalmente propagada devolve o MESMO nome (sem -2)', () => {
  const liberada = (branch) => pendingTargets(() => true).length === 0; // todos os destinos contêm a branch
  const nome = uniqueReleaseBranch('release/0.3.6', () => true, liberada);
  assert.equal(nome, 'release/0.3.6');
});

test('reciclagem: com propagação pendente, mantém o sufixo -2 (a branch velha ainda é necessária)', () => {
  const pendente = () => pendingTargets((t) => t === 'main').length > 0; // só a main contém: RELEASE/develop pendentes
  const existe = (n) => n === 'release/0.3.6'; // no remoto só a base existe; -2 é livre
  const nome = uniqueReleaseBranch('release/0.3.6', existe, () => !pendente());
  assert.equal(nome, 'release/0.3.6-2');
});

test('nome livre: sem branch existente, usa o nome sem sufixo', () => {
  const nome = uniqueReleaseBranch('release/0.3.6', () => false);
  assert.equal(nome, 'release/0.3.6');
});

test('assinatura antiga continua válida (sem o 3º parâmetro): sufixo como antes', () => {
  assert.equal(uniqueReleaseBranch('release/0.3.6', (n) => n === 'release/0.3.6'), 'release/0.3.6-2');
});

test('estratégia de propagação: gh-pr com Actions ligado, merge-local desligado (GH_ACTIONS=false)', () => {
  assert.equal(estrategiaPropagacao(true), 'gh-pr');
  assert.equal(estrategiaPropagacao(false), 'merge-local');
});

test('push direto em RELEASE (head sem merge commit) é negado APONTANDO o release-bump', () => {
  const d = pushDecision({ target: 'RELEASE', currentIsMergeCommit: false, force: false, deleting: false });
  assert.equal(d.decision, 'deny');
  assert.equal(d.key, 'gitflow.push.releaseDirect');
});

test('push em RELEASE COM merge commit no head passa; força em RELEASE segue proibida', () => {
  const ok = pushDecision({ target: 'RELEASE', currentIsMergeCommit: true, force: false, deleting: false });
  assert.equal(ok.ok, true);
  const forcado = pushDecision({ target: 'RELEASE', currentIsMergeCommit: true, forceWithLease: true, deleting: false });
  assert.equal(forcado.decision, 'deny');
  assert.equal(forcado.key, 'gitflow.push.forceProtected');
});

test('matriz completa para o merge local: release/x.y.z → RELEASE é permitido', () => {
  assert.equal(mergeDecision('RELEASE', 'release/0.3.6').ok, true);
});

test('matriz continua fechada fora das direções canônicas', () => {
  assert.equal(mergeDecision('develop', 'main').ok, undefined);
  assert.equal(mergeDecision('RELEASE', 'develop').ok, undefined);
  assert.equal(mergeDecision('main', 'develop').ok, undefined);
});

test('ordem de propagação intacta: RELEASE → main → develop', () => {
  assert.deepEqual(PROPAGATE_TO, ['RELEASE', 'main', 'develop']);
});
