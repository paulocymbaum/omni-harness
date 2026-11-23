import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rankToTop } from '../../scripts/tracker/rank.mjs';
import { moveToStatus } from '../../scripts/tracker/status.mjs';

const silent = { warn: () => {} };

/** Cliente fake com o mínimo do board: primeiro do ranking + chamada de rank registrada. */
function fakeJira({ first = 'OFLUXO-1', fail = null } = {}) {
  const calls = [];
  return {
    calls,
    firstRankedIssue: async () => {
      if (fail === 'first') throw new Error('sem permissão de busca');
      return first;
    },
    rankIssue: async (key, before) => {
      if (fail === 'rank') throw new Error('Rank field não configurado');
      calls.push({ key, before });
      return null;
    },
  };
}

describe('ranking do board no sync', () => {
  it('sobe o card antes do primeiro do projeto (é o topo da coluna dele)', async () => {
    const jira = fakeJira({ first: 'OFLUXO-1' });
    assert.equal(await rankToTop(jira, 'OFLUXO', 'OFLUXO-216', silent), true);
    assert.deepEqual(jira.calls, [{ key: 'OFLUXO-216', before: 'OFLUXO-1' }]);
  });

  it('card que já é o primeiro não é reordenado', async () => {
    const jira = fakeJira({ first: 'OFLUXO-216' });
    assert.equal(await rankToTop(jira, 'OFLUXO', 'OFLUXO-216', silent), true);
    assert.deepEqual(jira.calls, []);
  });

  it('projeto vazio (sem ranking) não chama o rank', async () => {
    const jira = fakeJira({ first: null });
    assert.equal(await rankToTop(jira, 'OFLUXO', 'OFLUXO-216', silent), true);
    assert.deepEqual(jira.calls, []);
  });

  it('falha de ranking avisa e não derruba o sync', async () => {
    const warnings = [];
    const jira = fakeJira({ fail: 'rank' });
    assert.equal(await rankToTop(jira, 'OFLUXO', 'OFLUXO-216', { warn: (m) => warnings.push(m) }), false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /não subiu ao topo do board/);
  });

  it('moveToStatus devolve true quando transiciona e false quando já está no destino', async () => {
    const transitions = [{ id: '31', name: 'Concluído', to: { name: 'Concluído' } }];
    const moved = [];
    const jira = {
      getTransitions: async () => ({ transitions: moved.length === 0 ? transitions : [] }),
      doTransition: async (key, id) => moved.push({ key, id }),
      getIssue: async () => ({ fields: { status: { name: 'Concluído' } } }),
    };
    assert.equal(await moveToStatus(jira, 'OFLUXO-216', 'Done'), true);
    assert.equal(await moveToStatus(jira, 'OFLUXO-216', 'Done'), false);
    assert.equal(moved.length, 1);
  });
});
