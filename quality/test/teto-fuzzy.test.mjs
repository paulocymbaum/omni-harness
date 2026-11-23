// Teto fuzzy de sleeps longos (comandos-curtos): determinismo, monotonia, zonas
// folgado/apertado/proibitivo e o rewrite de `sleep N` em comandos compostos.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PISO_MS,
  clampSleeps,
  pertinencias,
  tetoBrutoMs,
  tetoFuzzy,
} from '../lib/teto-fuzzy.mjs';

test('tetoBrutoMs aplica margem e overhead sobre o teto da ferramenta', () => {
  const bruto = tetoBrutoMs();
  assert.equal(bruto, Math.round(90_000 * 0.95 - 4_000));
  assert.ok(bruto > 0 && bruto < 90_000);
});

test('é determinístico: mesma entrada, mesma saída', () => {
  for (const ms of [5_000, 40_000, 60_000, 85_000, 120_000]) {
    const a = tetoFuzzy(ms);
    const b = tetoFuzzy(ms);
    assert.equal(a, b);
    assert.equal(clampSleeps(`sleep ${ms / 1000}; ps`), clampSleeps(`sleep ${ms / 1000}; ps`));
  }
});

test('folgado: esperas pequenas passam intactas', () => {
  assert.equal(tetoFuzzy(5_000), 5_000);
  assert.equal(tetoFuzzy(20_000), 20_000);
  assert.equal(clampSleeps('sleep 5; ps'), 'sleep 5; ps');
  assert.equal(clampSleeps('sleep 15; ps'), 'sleep 15; ps');
});

test('apertado/perigoso: rebaixa com suavidade e dentro dos limites', () => {
  for (const desejado of [45_000, 60_000, 75_000]) {
    const teto = tetoFuzzy(desejado);
    assert.ok(teto <= desejado, `${teto} <= ${desejado}`);
    assert.ok(teto >= PISO_MS, `${teto} >= ${PISO_MS}`);
    assert.ok(teto < desejado, `rebaixou: ${teto} < ${desejado}`);
  }
});

test('proibitivo: perto/antes do teto bruto rebaixa com força', () => {
  for (const desejado of [85_000, 90_000, 120_000]) {
    const teto = tetoFuzzy(desejado);
    assert.ok(teto < desejado / 2, `${teto} < metade de ${desejado}`);
  }
});

test('monotonia: desejado maior nunca devolve teto maior nas zonas rebaixadas', () => {
  let anterior = Number.POSITIVE_INFINITY;
  for (let ms = 55_000; ms <= 120_000; ms += 5_000) {
    const teto = tetoFuzzy(ms);
    assert.ok(teto <= anterior, `${teto} <= ${anterior} em ms=${ms}`);
    anterior = teto;
  }
});

test('pertinências: zonas com sobreposição e nenhuma lacuna', () => {
  for (let r = 0; r <= 1.2; r += 0.05) {
    const mu = pertinencias(r);
    const soma = Object.values(mu).reduce((acc, v) => acc + v, 0);
    assert.ok(soma > 0, `r=${r}: alguma pertinência ativa`);
    for (const v of Object.values(mu)) {
      assert.ok(v >= 0 && v <= 1, `r=${r}: pertinência em [0,1]`);
    }
  }
  assert.equal(pertinencias(0.1).folgado, 1);
  assert.equal(pertinencias(1.1).proibitivo, 1);
});

test('clampSleeps reescreve só o trecho de espera em comando composto', () => {
  const comando = 'sleep 85; ps -p 1; echo fim';
  const reescrito = clampSleeps(comando);
  assert.notEqual(reescrito, comando);
  assert.match(reescrito, /^sleep \d+; ps -p 1; echo fim$/);
  const seg = Number(reescrito.match(/^sleep (\d+)/)[1]);
  assert.ok(seg < 85 && seg >= PISO_MS / 1000);
});

test('sem sleep relevante devolve o comando original', () => {
  assert.equal(clampSleeps('ps -p 1'), 'ps -p 1');
  assert.equal(clampSleeps('sleep 3; ps'), 'sleep 3; ps');
  assert.equal(clampSleeps(''), '');
});
