// Helpers comuns dos gates dotnet do exemplo (DV/BIL/FC): um só parseTrx, walk, leitura e
// runDotnetGate — as cópias derivadas (bil/fc/dv-002) viram wrappers finos. Sem entrega aqui:
// família (templates, suporte, exclusões, prefixo TRX) entra por options. Prova local dos
// pedaços puros (os gates reais exigem dotnet + PostgreSQL + projeto hospedeiro).
// Rode: node --test quality/test/dotnet-gate-common.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTrx, trxFailureMessages, walkRel, readFileRel, existsRel } from '../examples/exemplo-saas/gates/dotnet-gate-common.mjs';
import { tempRepo } from './helpers.mjs';

const TRX = `<?xml version="1.0" encoding="utf-8"?>
<TestRun>
  <UnitTestResult testName="Exemplo SaaS.Api.Tests.GateBil002.Domain_Tests&quot;X&quot;" outcome="Passed" />
  <UnitTestResult testName="Exemplo SaaS.Api.Tests.GateBil002.Legacy_Tests" outcome="Failed">
    <Message>linha 1
linha 2
linha 3
linha 4</Message>
  </UnitTestResult>
  <UnitTestResult testName="Exemplo SaaS.Api.Tests.GateBil002.NotRun" outcome="NotRun" />
</TestRun>`;

test('parseTrx: nome decodificado, outcome presente e padrão Unknown', () => {
  const r = parseTrx(TRX);
  assert.deepEqual(r, [
    { name: 'Exemplo SaaS.Api.Tests.GateBil002.Domain_Tests"X"', outcome: 'Passed' },
    { name: 'Exemplo SaaS.Api.Tests.GateBil002.Legacy_Tests', outcome: 'Failed' },
    { name: 'Exemplo SaaS.Api.Tests.GateBil002.NotRun', outcome: 'NotRun' },
  ]);
});

test('trxFailureMessages: só os Failed, prefixo do namespace fora e 3 linhas no máximo', () => {
  const msgs = trxFailureMessages(TRX, 'Exemplo SaaS.Api.Tests');
  assert.deepEqual(msgs, ['GateBil002.Legacy_Tests: linha 1 linha 2 linha 3']);
});

test('walkRel: caminhos POSIX relativos, pastas excluídas fora, ausente devolve []', () => {
  const repo = tempRepo({
    'src/A.cs': 'class A {}\n',
    'src/deep/B.cs': 'class B {}\n',
    'bin/gen.cs': 'class Gen {}\n',
    'obj/gen.cs': 'class Gen {}\n',
    'src/notas.md': '# nota\n',
  });
  try {
    const all = walkRel(repo.dir, 'src', (f) => f.endsWith('.cs'));
    assert.deepEqual(all, ['src/A.cs', 'src/deep/B.cs']);
    assert.deepEqual(walkRel(repo.dir, 'nada/aqui'), [], 'diretório ausente deve devolver []');
    assert.deepEqual(walkRel(repo.dir, '.', (f) => f.endsWith('.cs')), ['src/A.cs', 'src/deep/B.cs'],
      'exclusões padrão (bin/obj/node_modules) escondem os gerados');
  } finally { repo.cleanup(); }
});

test('readFileRel/existsRel: leitura exige existência com mensagem acionável', () => {
  const repo = tempRepo({ 'src/A.cs': 'class A {}\n' });
  try {
    assert.equal(readFileRel(repo.dir, 'src/A.cs'), 'class A {}\n');
    assert.equal(existsRel(repo.dir, 'src/A.cs'), true);
    assert.equal(existsRel(repo.dir, 'src/Z.cs'), false);
    assert.throws(() => readFileRel(repo.dir, 'src/Z.cs'), /arquivo ausente: src\/Z\.cs/);
  } finally { repo.cleanup(); }
});
