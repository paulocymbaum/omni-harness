// Gate MAN-005-SHARE-PANEL — acessos rápidos: WhatsApp, Instagram, link público, share sheet.
// ANTES da implementação este teste DEVE falhar (invite_share_panel.dart ainda não existe).
// Baseline: node quality/delivery/eval.mjs docs/entregas/2026-10-26-manifestacoes-caronas MAN-005 --baseline
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const PANEL = 'lib/features/events/presentation/widgets/invite_share_panel.dart';
const src = fs.readFileSync(PANEL, 'utf8');

test('painel do convite existe e carrega título, horário e link curto', () => {
  assert.match(src, /class\s+InviteSharePanel/, 'widget InviteSharePanel deve existir');
  assert.match(src, /shortLink/, 'painel recebe o link curto (MAN-004)');
});

test('WhatsApp abre convite pré-montado via wa.me e url_launcher', () => {
  assert.match(src, /https:\/\/wa\.me\//, 'constante kWhatsAppShareBase com wa.me');
  assert.match(src, /launchUrl/, 'abre o deep link com url_launcher (dependência existente)');
  assert.match(src, /text=/, 'mensagem do convite pré-montada no parâmetro text');
});

test('Instagram usa card para Stories com fallback de copiar e abrir', () => {
  assert.match(src, /instagram-stories|InviteInstagramCard|InstagramStory/, 'canal/card de Stories do Instagram');
  assert.match(src, /Clipboard\.setData/, 'fallback copia o link quando Stories não suportado');
});

test('link público copia o slug e "Mais opções" usa o share sheet nativo', () => {
  assert.match(src, /ClipboardData\(\s*text:\s*shortLink/, 'ação Link público copia o slug');
  assert.match(src, /SharePlus|Share\.share\(/, '"Mais opções" usa share_plus (dependência existente)');
});
