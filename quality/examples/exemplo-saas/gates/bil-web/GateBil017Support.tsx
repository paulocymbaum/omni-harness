// Apoio dos gates BIL-017 do site. Template do autor de gates, copiado para pages/ só durante o gate.
// Firestore falso na fronteira do SDK: aplica de verdade os filtros `==`, então consulta por campo errado devolve vazio, como no banco.
// O mock de `firebase/firestore` e o de `@/platform/infrastructure/firebase` ficam em cada teste, porque vi.mock é por arquivo.
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

type Row = Record<string, unknown> & { id: string };
type Filter = { field: string; value: unknown };
type Source = { name: string; filters: Filter[] };

export const store = {
  collections: {} as Record<string, Row[]>,
  documents: {} as Record<string, Record<string, unknown>>,
  denied: new Set<string>(),
  reset() { this.collections = {}; this.documents = {}; this.denied = new Set(); },
};

export const fakeFirestore = {
  collection: (_db: unknown, name: string): Source => ({ name, filters: [] }),
  query: (source: Source, ...parts: (Filter | null)[]): Source => ({ ...source, filters: [...source.filters, ...parts.filter((p): p is Filter => Boolean(p?.field))] }),
  where: (field: string, op: string, value: unknown) => (op === '==' ? { field, value } : null),
  orderBy: () => null,
  limit: () => null,
  doc: (_db: unknown, ...path: string[]) => ({ path: path.join('/'), id: path.at(-1) }),
  getDoc: async (ref: { path: string; id: string }) => {
    const data = store.documents[ref.path];
    return { id: ref.id, exists: () => data !== undefined, data: () => data, get: (f: string) => data?.[f] };
  },
  onSnapshot: (source: Source, next: (snap: unknown) => void, fail: (error: unknown) => void) => {
    queueMicrotask(() => {
      if (store.denied.has(source.name)) {
        fail(Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }));
        return;
      }
      const rows = (store.collections[source.name] ?? []).filter((row) => source.filters.every((f) => row[f.field] === f.value));
      const docs = rows.map((row) => ({ id: row.id, data: () => row }));
      next({ docs, size: docs.length, empty: docs.length === 0 });
    });
    return () => undefined;
  },
};

export function seedBusiness(id: string, uid: string, fluxoBusinessType: string, extra: Record<string, unknown> = {}) {
  store.documents[`accountContexts/${uid}`] = { availableBusinessIds: [id] };
  store.documents[`businessProfiles/${id}/members/${uid}`] = { uid, status: 'active', role: 'ADMIN' };
  store.documents[`businessProfiles/${id}`] = { tradeName: 'Brasa Gate', legalName: 'Brasa Gate Ltda', fluxoBusinessType, ...extra };
}

function Where() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

/** Monta a tela pela rota real do módulo. Fora dela, mostra só onde a navegação parou. */
export function mountModule(page: ReactElement, businessId: string, module: string) {
  return render(
    <MemoryRouter initialEntries={[`/app/business/${businessId}/${module}`]}>
      <Routes>
        <Route path="/app/business/:businessId/:module" element={<>{page}<Where /></>} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}
