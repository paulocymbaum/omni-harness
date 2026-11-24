// Gate de entrega CS-010: card recém-sincronizado sobe ao TOPO da coluna (rank). Sem isso o Jira anexa o
// card ao fim da coluna e ele parece não existir no kanban — foi exatamente o que aconteceu com CS-007..009.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { exists, read, stripComments } from './fc-gate-helper.mjs';

const RANK = 'scripts/jira/rank.mjs';
const SYNC = 'scripts/jira/sync-context.mjs';
const CLIENT = 'scripts/jira/jira-client.mjs';

describe('Jira: card novo aparece no topo do kanban', () => {
  it('CS-010 rank: o cliente expõe ranking e o sync sobe o card criado/transicionado', () => {
    const client = stripComments(read(CLIENT));
    assert.match(client, /firstRankedIssue: async \(projectKey\) => \{/);
    assert.match(client, /rankIssue: \(issueKey, beforeKey\) =>/);
    assert.match(client, /\/rest\/agile\/1\.0\/issue\/rank/);

    assert.ok(exists(RANK), 'scripts/jira/rank.mjs ausente');
    const rank = stripComments(read(RANK));
    assert.match(rank, /export async function rankToTop\(jira, projectKey, key, log = console\) \{/);
    assert.match(rank, /const first = await jira\.firstRankedIssue\(projectKey\);/);
    assert.match(rank, /if \(first && first !== key\) await jira\.rankIssue\(key, first\);/);

    const sync = stripComments(read(SYNC));
    assert.match(sync, /import \{ rankToTop \} from '\.\/rank\.mjs';/);
    assert.match(sync, /const \{ key, created \} = await upsertIssue\(/);
    assert.match(sync, /const moved = await moveToStatus\(jira, key, jiraStatus\);/);
    assert.match(sync, /if \(created \|\| moved\) await rankToTop\(jira, projectKey, key\);/);
  });

  it('CS-010 rank: transição devolve se o card mudou de coluna (a decisão de reordenar depende disso)', () => {
    const status = stripComments(read('scripts/jira/status.mjs'));
    assert.match(status, /if \(direct\) \{ await jira\.doTransition\(key, direct\.id\); await claimCard\(jira, key\); return true; \}/);
    assert.match(status, /if \(current === jiraStatus\) return false;/);
  });

  it('CS-010 rank: ranking é melhor esforço — falha avisa e o sync continua', () => {
    const rank = stripComments(read(RANK));
    assert.match(rank, /catch \(error\) \{/);
    assert.match(rank, /não subiu ao topo do board/);
    assert.match(rank, /return false;/);

    const unit = read('quality/test/jira-rank.test.mjs');
    assert.match(unit, /sobe o card antes do primeiro do projeto/);
    assert.match(unit, /falha de ranking avisa e não derruba o sync/);
    assert.match(unit, /card que já é o primeiro não é reordenado/);
  });
});
