import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommand, stripHeredocs, splitCommands } from '../lib/shell.mjs';

const types = (cmd) => classifyCommand(cmd).map((a) => a.type);

test('detecta commit, push e deploy reais', () => {
  assert.deepEqual(types('git commit -m "fix"'), ['commit']);
  assert.deepEqual(types('git add -A && git commit -m x'), ['commit']);
  assert.deepEqual(types('git -C backend commit -am x'), ['commit']);
  assert.deepEqual(types('rtk git push origin HEAD'), ['push']);
  assert.deepEqual(types('GIT_EDITOR=true git commit'), ['commit']);
  assert.deepEqual(types('firebase deploy --only functions'), ['deploy']);
  assert.deepEqual(types('npx firebase-tools deploy --only hosting'), ['deploy']);
  assert.deepEqual(types('gcloud run deploy fluxo-api --image x --region southamerica-east1'), ['deploy']);
  assert.deepEqual(types('gcloud beta run services update fluxo-api --min-instances=2'), ['deploy']);
  assert.deepEqual(types('gcloud run jobs execute fluxo-artist-sync'), ['deploy']);
  assert.deepEqual(types('gcloud scheduler jobs update http x --schedule="*/5 * * * *"'), ['deploy']);
  assert.deepEqual(types('terraform -chdir=infra/gcp/terraform apply'), ['deploy']);
  assert.deepEqual(types('dotnet ef database update'), ['deploy']);
  assert.deepEqual(types('npm --prefix functions run deploy'), ['deploy']);
  assert.deepEqual(types('bash -c "git commit -m x"'), ['commit']);
  assert.deepEqual(types('./scripts/cutover_users_bucket.sh prod'), ['deploy']);
});

test('não dispara em strings, heredocs, echo, grep ou comandos somente leitura (falso positivo)', () => {
  assert.deepEqual(types('echo "git commit -m x"'), []);
  assert.deepEqual(types("grep -rn 'firebase deploy' docs/"), []);
  assert.deepEqual(types('git log --oneline -5'), []);
  assert.deepEqual(types('git status && git diff HEAD'), []);
  assert.deepEqual(types('git push --dry-run'), []);
  assert.deepEqual(types('git commit --help'), []);
  assert.deepEqual(types('gcloud run services describe fluxo-api'), []);
  assert.deepEqual(types('gcloud logging read "resource.type=cloud_run_revision"'), []);
  assert.deepEqual(types('terraform plan'), []);
  assert.deepEqual(types('npm run build && npm test'), []);
  assert.deepEqual(types('cat README.md | grep deploy'), []);
  assert.deepEqual(types('cat > notes.md <<EOF\ngit push origin main\nfirebase deploy\nEOF'), []);
  assert.deepEqual(types('node quality/run.mjs --tier rotina'), []);
});

test('mensagem de commit com ; e heredoc não gera push/deploy fantasma', () => {
  const cmd = `git commit -m "$(cat <<'EOF'\nfix: ajuste; git push depois\n\nfirebase deploy manual\nEOF\n)"`;
  assert.deepEqual(types(cmd), ['commit']);
  assert.deepEqual(types('git commit -m "a; git push; firebase deploy"'), ['commit']);
});

test('coleta flags de custo em deploys', () => {
  const [a] = classifyCommand('gcloud run deploy api --min-instances=3 --memory 1Gi');
  assert.deepEqual(a.costFlags.sort(), ['--memory', '--min-instances']);
  const [b] = classifyCommand('terraform apply -auto-approve');
  assert.ok(b.costFlags.includes('terraform'));
});

test('utilitários: heredoc e divisão por operadores', () => {
  assert.equal(stripHeredocs('cat <<EOF\nx\nEOF\necho y'), 'cat <<EOF\necho y');
  assert.deepEqual(splitCommands('a && b || c; d | e'), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(splitCommands('echo "a && b"'), ['echo "a && b"']);
});
