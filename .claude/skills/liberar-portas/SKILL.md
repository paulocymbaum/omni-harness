---
name: liberar-portas
description: Encerra os processos que escutam uma ou várias portas TCP locais (emuladores, servidores de teste, API .NET, Vite) com segurança. Use quando uma porta estiver ocupada, quando um gate ou teste falhar por "address already in use", ou antes de subir de novo um emulador ou serviço local.
---

# Liberar portas

Script determinístico em vez de `pkill` solto: [scripts/dev/liberar-portas.mjs](../../../scripts/dev/liberar-portas.mjs).

```bash
node scripts/dev/liberar-portas.mjs 8089                 # uma porta
node scripts/dev/liberar-portas.mjs 8089 55432 5173      # várias
node scripts/dev/liberar-portas.mjs 8000-8010            # faixa
node scripts/dev/liberar-portas.mjs 8089 --dry-run       # só lista
node scripts/dev/liberar-portas.mjs 8089 --force         # SIGKILL direto
```

## Comportamento

- Padrão: `SIGTERM`, espera até 3 s (`--wait <ms>`) e escala para `SIGKILL` se o processo seguir vivo.
- Só processos em `LISTEN`, só portas 1024-65535, no máximo 50 por chamada.
- Nunca encerra o próprio script nem seus ancestrais (a sessão do agente).
- `docker-proxy` é pulado com saída 2: contêiner se encerra com `docker stop <nome>`, não matando o proxy.
- Saída por porta: `livre`, `encerrado`, `pulado`, `AINDA VIVO`. Código 0 = tudo certo, 1 = falha ao encerrar, 2 = só contêiner.

## Portas usadas no harness

| Porta | O que é |
|---|---|
| 8089 | emulador do Firestore dos gates .NET (`FIRESTORE_EMULATOR_HOST`) |
| 55432 | Postgres descartável dos gates (`FLUXO_TEST_POSTGRES`), em contêiner: `docker stop fc-pg` |
| 5173 | Vite do `ofluxo_site` |

## Regras

1. Rode `--dry-run` primeiro quando não souber o que ocupa a porta.
2. Não encerre processos que você não subiu nesta tarefa sem o usuário confirmar.
3. Nunca use `pkill -f` por nome: pode pegar processos de outras sessões.
