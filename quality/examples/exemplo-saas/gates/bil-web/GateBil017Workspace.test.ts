// Gate BIL-017-PARIDADE-WORKSPACE, lado TypeScript. Template do autor de gates, copiado para domain/ só durante o gate.
// Contrato que este template fixa, além da spec, igual ao Dart: workspaceFor(primaryType, cnaes) devolve `tabs` e `copyFor(tab)`, e os campos e rótulos do golden têm o mesmo nome.
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import * as workspace from './business-workspace';

type Case = { primaryType: string; cnaes: (string | null)[]; expected: Record<string, unknown> & { tabs: { key: string }[]; merchantType: string } };

const golden = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), '../quality/test/delivery/fixtures/bil-017-workspace.golden.json'), 'utf8')) as { cases: Case[] };
const norm = (value: unknown): unknown => {
  if (typeof value === 'string') return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  if (Array.isArray(value)) return value.map(norm);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, norm(v)]));
  return value;
};
const LABELS = ['catalogItemLabel', 'catalogItemNameLabel', 'catalogImageTitle', 'catalogImageSubtitle', 'defaultOrderItemName', 'defaultServiceName'] as const;

describe('paridade: golden do app', () => {
  it('o golden cobre 7 tipos, valor desconhecido e híbridos', () => {
    expect(new Set(golden.cases.map((c) => c.primaryType)).size).toBeGreaterThanOrEqual(8);
    expect(golden.cases.filter((c) => c.cnaes.some(Boolean)).length).toBeGreaterThanOrEqual(15);
  });

  for (const c of golden.cases) {
    it(`${c.primaryType || '(vazio)'} ${c.cnaes.join(' ')}`, () => {
      const w = workspace.workspaceFor(c.primaryType, c.cnaes) as unknown as Record<string, unknown> & { tabs: string[]; copyFor: (tab: string) => { label: string; title: string } };
      const { tabs, merchantType, ...fields } = c.expected;
      expect(norm(w.tabs.map((key) => ({ key, label: w.copyFor(key).label, title: w.copyFor(key).title })))).toEqual(norm(tabs));
      expect(norm(workspace.merchantTypeFromBusinessType(c.primaryType))).toEqual(norm(merchantType));
      for (const [name, value] of Object.entries(fields)) {
        const actual = (LABELS as readonly string[]).includes(name)
          ? (workspace as unknown as Record<string, (w: unknown) => string>)[name](w)
          : w[name];
        expect(norm(actual), name).toEqual(norm(value));
      }
    });
  }
});
