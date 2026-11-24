// Gate BIL-008-VITEST (chave). Template do autor de gates, copiado para o site só durante o gate.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearBillingKey, stableBillingKey } from './billing-idempotency';

const memory = (): Storage => {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => { data.delete(key); },
    setItem: (key, value) => { data.set(key, value); },
  };
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('stableBillingKey', () => {
  afterEach(() => { sessionStorage.clear(); vi.resetModules(); });

  it('devolve a mesma chave, um UUID, guardada em billing:key:<scope>:<id>', () => {
    const storage = memory();
    const key = stableBillingKey('charge', 'inv-1', storage);
    expect(key).toMatch(UUID);
    expect(stableBillingKey('charge', 'inv-1', storage)).toBe(key);
    expect(storage.getItem('billing:key:charge:inv-1')).toBe(key);
  });

  it('sobrevive a recarregar a página', async () => {
    const key = stableBillingKey('subscription', 'emp:preco');
    vi.resetModules();
    const fresh = await import('./billing-idempotency');
    expect(fresh.stableBillingKey('subscription', 'emp:preco')).toBe(key);
  });

  it('separa escopos e intenções', () => {
    const storage = memory();
    const keys = [stableBillingKey('charge', 'a', storage), stableBillingKey('charge', 'b', storage), stableBillingKey('subscription', 'a', storage)];
    expect(new Set(keys).size).toBe(3);
  });

  it('clearBillingKey gera uma nova na próxima chamada e não toca nas outras', () => {
    const storage = memory();
    const [first, other] = [stableBillingKey('charge', 'a', storage), stableBillingKey('charge', 'b', storage)];
    clearBillingKey('charge', 'a', storage);
    expect(stableBillingKey('charge', 'a', storage)).not.toBe(first);
    expect(stableBillingKey('charge', 'b', storage)).toBe(other);
  });
});
