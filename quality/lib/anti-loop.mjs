// Anti-loop do run_commands no Cline CLI/SDK: o detector do harness para a tarefa
// inteira após 5 chamadas idênticas consecutivas (caso real: polls de
// `sleep N; ps -p PID` aguardando um gate em background, 5× seguidas →
// tool_execution_failed). Este módulo guarda o hash do último comando por sessão
// num arquivo de estado e decide:
//   1ª-2ª repetição idêntica → passa igual (poll legítimo);
//   3ª                       → aplica variação determinística no comando
//                              (`… # poll 3`), então o detector nunca vê 5 iguais;
//   4ª ou mais               → além da variação, pede que o agente troque de
//                              estratégia (trabalho útil entre checagens, helper
//                              de espera ou leitura do log sem shell).
// Cálculo puro e determinístico; o único I/O é o arquivo de estado, e qualquer
// erro é fail-open (comando original, sem aviso).
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const JANELA_MS = 6 * 60 * 60 * 1000; // sessões de estado expiram em 6 h.

const hashDe = (comando) =>
  createHash('sha256').update(comando.trim()).digest('hex').slice(0, 16);

const lerEstado = (stateFile) => {
  try {
    const raiz = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return raiz?.sessoes ? raiz : { sessoes: {} };
  } catch {
    return { sessoes: {} };
  }
};

const podar = (raiz, agora) => {
  for (const [id, entrada] of Object.entries(raiz.sessoes)) {
    if (!entrada || agora - (entrada.atualizadoEm ?? 0) > JANELA_MS) {
      delete raiz.sessoes[id];
    }
  }
};

const salvar = (stateFile, raiz) => {
  try {
    fs.mkdirSync(stateFile.slice(0, stateFile.lastIndexOf('/')), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(raiz));
  } catch {
    // Estado é melhor-effort: sem arquivo, sem variação.
  }
};

/** Sessão atual com poda das que expiraram. */
const estado = (stateFile, sessionId, agora) => {
  const raiz = lerEstado(stateFile);
  podar(raiz, agora);
  return raiz.sessoes[sessionId] ?? { hash: '', tick: 0 };
};

const entradaVazia = (normalizado, stateFile, sessionId) =>
  !normalizado || !stateFile || !sessionId;

const proximoTick = (anterior, hash) =>
  anterior?.hash === hash ? (anterior.tick ?? 0) + 1 : 1;

/**
 * Registra uma chamada de comando e devolve o veredito anti-loop:
 *   { repeticoes, comandoFinal, avisar }
 * `comandoFinal` é o comando com variação determinística quando repetições
 * idênticas chegam à 3ª — mesmo input do agente, saída diferente para o
 * detector. Na 4ª+, `avisar` pede troca de estratégia.
 */
export const registrarComando = ({
  stateFile,
  sessionId,
  comando,
  agora = Date.now(),
}) => {
  const normalizado = String(comando ?? '').trim();
  if (entradaVazia(normalizado, stateFile, sessionId)) {
    return { repeticoes: 1, comandoFinal: comando ?? '', avisar: false };
  }
  const raiz = lerEstado(stateFile);
  podar(raiz, agora);
  const hash = hashDe(normalizado);
  const tick = proximoTick(raiz.sessoes[sessionId], hash);
  raiz.sessoes[sessionId] = { hash, tick, atualizadoEm: agora };
  salvar(stateFile, raiz);
  return {
    repeticoes: tick,
    comandoFinal: tick >= 3 ? `${normalizado} # poll ${tick}` : normalizado,
    avisar: tick >= 4,
  };
};
