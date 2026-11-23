// Teto de espera por comando com lógica fuzzy determinística (Mamdani com saídas singleton).
// Observado no harness do Cline CLI: chamadas de run_commands são interrompidas perto de ~90 s
// (regra comandos-curtos: nenhum comando acima de ~90 s). O teto exato varia (jitter do shell,
// hooks, rtk), então um corte seco em 90 s falha dos dois lados: 85 s às vezes passa, às vezes
// é abortado. A lógica fuzzy troca o corte por transições suaves sobre a razão
// r = desejado / tetoBruto, com conjuntos linguísticos {folgado, apertado, perigoso, proibitivo},
// regras com saídas singleton e defuzzificação por média ponderada — determinística: mesmas
// entradas, mesma saída (sem relógio, sem aleatoriedade). Usado pelo rewrite do PreToolUse do
// Cline para rebaixar `sleep N` acima do teto seguro, e exportado para testes e para agentes
// que queiram calcular o teto antes de montar o comando.

/** Observação do harness: aborta por perto de 90 s (regra comandos-curtos usa o mesmo teto). */
export const TETO_FERRAMENTA_MS = 90_000;

/** Margem contra o jitter do shell + hooks de Pre/PostToolUse (~4 s observados). */
export const MARGEM = 0.95;
export const OVERHEAD_MS = 4_000;

/** Piso do poll: abaixo disso o teto devolve o valor desejado sem tocar. */
export const PISO_MS = 15_000;

/** Teto bruto (ms): aquilo que, sem fuzzy, seria o corte seco. */
export const tetoBrutoMs = () =>
  Math.round(TETO_FERRAMENTA_MS * MARGEM - OVERHEAD_MS);

const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** Triangular: sobe de a até pico, desce de pico até b. Zerá fora de [a, b]. */
const tri = (x, a, pico, b) => {
  if (x <= a || x >= b) return 0;
  if (x < pico) return clamp01((x - a) / (pico - a));
  return clamp01((b - x) / (b - pico));
};

/** Trapezoidal: sobe a→b, platô b→c, desce c→d. Zero fora de [a, d]. Platos degenerados ok. */
const trap = (x, a, b, c, d) => {
  if (x < a || x > d) return 0;
  if (x <= b) return b === a ? 1 : clamp01((x - a) / (b - a));
  if (x >= c) return c === d ? 1 : clamp01((d - x) / (d - c));
  return 1;
};

/**
 * Pertinências sobre a razão r = desejado / tetoBruto. Zonas com sobreposição
 * proposital: entre 0,35 e 1,3 dois conjuntos estão sempre parcialmente ativos
 * (sem degraus nem lacunas), o que dá a transição suave. `perigoso` tem ombro
 * que permanece ativo além de 1,0 (é o proibitivo que assume na razão alta).
 */
export const pertinencias = (r) => ({
  folgado: trap(r, -0.1, 0, 0.35, 0.55),
  apertado: tri(r, 0.35, 0.55, 0.8),
  perigoso: trap(r, 0.55, 0.8, 1.0, 1.3),
  proibitivo: clamp01((r - 0.8) / 0.2),
});

/** Saídas singleton por regra: fração do desejado permitida em cada zona. */
const SAIDAS = { folgado: 1, apertado: 0.75, perigoso: 0.5, proibitivo: 0.12 };

/**
 * Teto seguro (ms) para uma espera desejada. Função variável pura: mesma entrada,
 * mesma saída. Exemplos com o teto bruto ≈ 81,5 s:
 *   tetoFuzzy(20_000)  → 20_000  (folgado: não mexe)
 *   tetoFuzzy(60_000)  → ≈40_000 (apertado/perigoso: rebaixa com suavidade)
 *   tetoFuzzy(85_000)  → ≈26_000 (proibitivo dominante: rebaixa com força)
 */
export const tetoFuzzy = (desejadoMs, opcoes = {}) => {
  const bruto = opcoes.brutoMs ?? tetoBrutoMs();
  const desejado = Math.max(0, Math.round(desejadoMs));
  if (desejado === 0) return 0;
  const r = desejado / bruto;
  const mu = pertinencias(r);
  let soma = 0;
  let peso = 0;
  for (const conjunto of Object.keys(SAIDAS)) {
    soma += mu[conjunto] * SAIDAS[conjunto];
    peso += mu[conjunto];
  }
  const fracao = peso > 0 ? soma / peso : 1;
  const teto = Math.round(desejado * fracao);
  // Piso: polls curtos continuam utilizáveis; desejos pequenos passam intactos.
  return Math.min(desejado, Math.max(teto, desejado <= PISO_MS ? desejado : PISO_MS));
};

const RE_SLEEP = /(^|[;&|]\s*)sleep\s+(\d{2,})(?=\s|$|[;&|])/g;

/**
 * Rebaixa `sleep N` (N inteiro ≥ 10 s) acima do teto seguro dentro de um comando
 * composto (`sleep 85; ps …` → `sleep 26; ps …`). Determinístico; devolve o
 * comando original quando nada muda. Sono em subsegundos não é tocado.
 */
export const clampSleeps = (command, opcoes = {}) => {
  if (!command?.includes('sleep')) return command ?? '';
  const bruto = opcoes.brutoMs ?? tetoBrutoMs();
  return command.replace(RE_SLEEP, (inteiro, prefixo, seg) => {
    const seguro = Math.round(tetoFuzzy(Number(seg) * 1000, { brutoMs: bruto }) / 1000);
    return seguro === Number(seg) ? inteiro : `${prefixo}sleep ${seguro}`;
  });
};
