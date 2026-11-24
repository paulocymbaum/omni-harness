// Gates PF-004 — execução real de jornadas nativas e evidência mensurada.
// Não lê paridade.md/evidencias.md/entrega.md: texto documental nunca aprova gate.
import { test } from 'node:test';
import {
  runNativeJourney,
  runPerformanceJourney,
} from './pf-004-gate-helper.mjs';

const ANDROID = 'android';
const IOS = 'ios';

test('PF-004 ANDROID-PARITY: jornada Pulso navega e retorna mantendo o estado em Android nativo', () => {
  runNativeJourney({
    platform: ANDROID,
    name: 'PF-004 ANDROID-PARITY — navegação nativa preserva recorte, filtros, câmera e seleção ao voltar',
  });
});

test('PF-004 IOS-PARITY: jornada Pulso navega e retorna mantendo o estado em iOS nativo', () => {
  runNativeJourney({
    platform: IOS,
    name: 'PF-004 IOS-PARITY — navegação nativa preserva recorte, filtros, câmera e seleção ao voltar',
  });
});

test('PF-004 ANDROID-PRIVATE: evento privado não aparece na descoberta e respeita leitura autorizada em Android', () => {
  runNativeJourney({
    platform: ANDROID,
    name: 'PF-004 ANDROID-PRIVATE — privado ausente da lista pública, detalhe negado a convidado e acessível ao autorizado',
  });
});

test('PF-004 IOS-PRIVATE: evento privado não aparece na descoberta e respeita leitura autorizada em iOS', () => {
  runNativeJourney({
    platform: IOS,
    name: 'PF-004 IOS-PRIVATE — privado ausente da lista pública, detalhe negado a convidado e acessível ao autorizado',
  });
});

test('PF-004 ANDROID-PERFORMANCE: medições Android reais respeitam orçamento aprovado e identificado', () => {
  runPerformanceJourney({
    platform: ANDROID,
    name: 'PF-004 ANDROID-PERFORMANCE — mede carga BR UF ZZ, memória, cache, quadros, gestos e estilo no aparelho',
  });
});

test('PF-004 IOS-PERFORMANCE: medições iOS reais respeitam orçamento aprovado e identificado', () => {
  runPerformanceJourney({
    platform: IOS,
    name: 'PF-004 IOS-PERFORMANCE — mede carga BR UF ZZ, memória, cache, quadros, gestos e estilo no aparelho',
  });
});

test('PF-004 ANDROID-ROLLOUT: smoke read-only de staging verifica transporte, privacidade e compatibilidade de rollback', () => {
  runNativeJourney({
    platform: ANDROID,
    name: 'PF-004 ANDROID-ROLLOUT — smoke read-only confirma snapshots públicos, API protegida, projeção e rollback seguro',
    rolloutEvidence: true,
  });
});

test('PF-004 IOS-ROLLOUT: smoke read-only de staging verifica transporte, privacidade e compatibilidade de rollback', () => {
  runNativeJourney({
    platform: IOS,
    name: 'PF-004 IOS-ROLLOUT — smoke read-only confirma snapshots públicos, API protegida, projeção e rollback seguro',
    rolloutEvidence: true,
  });
});
