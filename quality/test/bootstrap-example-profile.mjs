// Bootstrap de testes do motor que exercitam o EXEMPLO (fluxo): define HARNESS_PROFILE_DIR
// ANTES dos imports estáticos dos módulos consumidores (o singleton do perfil é carregado na
// primeira avaliação de import — por isso este módulo deve ser o PRIMEIRO import do arquivo
// de teste). Importe-o como primeira linha; não faz nada se o exemplo não existir.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const exemplo = path.join(root, 'quality', 'examples', 'fluxo', 'profile');
if (fs.existsSync(path.join(exemplo, 'profile.json'))) {
  process.env.HARNESS_PROFILE_DIR ??= exemplo;
}
