// Gate QG-001-PINS — supply chain de CI: toda action referenciada em .github/workflows
// deve estar pinada por SHA de commit (40 hex), nunca por tag solta (@v4).
// Antes da implementação este teste DEVE falhar (presence-integrity.yml usava @v4/@v2).
// Rode: node --test quality/test/delivery/qg-001.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WF_DIR = path.join(ROOT, '.github', 'workflows');
// owner/repo@<40 hex> — tolera comentário de versão depois do SHA (convenção do repositório).
const PINNED = /^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+@[0-9a-f]{40}(?:\s|#|$)/;

test('qg-001: toda action de workflow está pinada por SHA de commit', () => {
  assert(fs.existsSync(WF_DIR), 'diretório .github/workflows não encontrado');
  const files = fs.readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f));
  assert(files.length > 0, 'nenhum workflow encontrado em .github/workflows');

  const soltos = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(WF_DIR, f), 'utf8');
    for (const m of text.matchAll(/(?:^|\n)\s*(?:- )?uses:\s*(\S+)/g)) {
      const ref = m[1];
      // Actions locais (./caminho) e imagens docker:// não têm SHA de repositório.
      if (ref.startsWith('./') || ref.startsWith('docker://')) continue;
      if (!PINNED.test(ref)) soltos.push(`${f}: ${ref}`);
    }
  }
  assert.deepEqual(
    soltos,
    [],
    `actions sem pin por SHA (risco de supply chain): ${soltos.join(', ')}`,
  );
});
