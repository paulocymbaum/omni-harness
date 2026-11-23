#!/usr/bin/env node
// Worker da paralelização P1 (docs/parking-lot/performance-camadas.md): recebe por stdin
// { tier, entries, camadas, grupos, budgetMs }, roda SÓ os grupos pedidos com o MESMO perfil
// (env herdado) e responde { results } no stdout. Crash/timeout = o pai marca a camada como
// não medida (camada.unmeasured WARN) — falha aberta, nunca derruba o trabalho.
import { rodarGrupo } from './tiers.mjs';

let bruto = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { bruto += c; });
process.stdin.on('end', () => {
  const pedido = JSON.parse(bruto);
  const results = rodarGrupo(pedido.tier, pedido.entries, pedido.camadas ?? [], pedido.grupos, pedido.budgetMs);
  process.stdout.write(JSON.stringify({ results }));
});
