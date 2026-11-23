// Namespace neutro de variáveis de ambiente (R5): HARNESS_<NOME> é o nome canônico; FLUXO_<NOME>
// permanece como ALIAS retrocompatível durante a transição (docs/harness/12). Nada aqui lança.
const CANONICAL = 'HARNESS_';
const ALIAS = 'FLUXO_';

/** Valor bruto: HARNESS_<name> tem precedência; FLUXO_<name> é o alias. undefined se nenhum. */
export function harnessEnv(name, env = process.env) {
  if (env[`${CANONICAL}${name}`] !== undefined) return env[`${CANONICAL}${name}`];
  return env[`${ALIAS}${name}`];
}

/** Chave de desligamento por valor "0" (padrão dos switches do harness). */
export function envOff(name, env = process.env) {
  return harnessEnv(name, env) === '0';
}
