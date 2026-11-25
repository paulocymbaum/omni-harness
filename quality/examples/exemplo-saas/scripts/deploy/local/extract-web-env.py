#!/usr/bin/env python3
"""Extrai os VITE_* PÚBLICOS do bundle publicado do Fluxo Web (ofluxo.web.app).

A client config do Firebase e a site key do reCAPTCHA Enterprise são públicas por design — elas
já estão no bundle de produção. Uso: fallback do deploy-web.sh quando o Doppler prd ainda não tem
os VITE_FIREBASE_*. Escreve no stdout linhas `CHAVE=valor` para o shell fazer o source.
"""
import re
import urllib.request

BASE = 'https://ofluxo.web.app/assets/'
SEED = ['index.js']

def index_name():
    html = urllib.request.urlopen('https://ofluxo.web.app/', timeout=20).read().decode('utf8', 'ignore')
    match = re.search(r'(index-[A-Za-z0-9_-]+\.js)', html)
    return match.group(1) if match else SEED[0]

def main():
    seen, text = set(), []
    queue = [index_name()]
    for _ in range(2):
        for name in queue:
            if name in seen:
                continue
            seen.add(name)
            try:
                text.append(urllib.request.urlopen(BASE + name, timeout=20).read().decode('utf8', 'ignore'))
            except Exception:
                pass  # crawl tolerante: índice parcial é aceitável, nomes voltam na próxima rodada
        queue = list(dict.fromkeys(re.findall(r'[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.js', ''.join(text))))
    blob = ''.join(text)
    fields = {
        'VITE_FIREBASE_API_KEY': r'AIza[A-Za-z0-9_\-]{30,40}',
        'VITE_FIREBASE_APP_ID': r'1:41695569839:web:[A-Za-z0-9_\-]+',
        'VITE_FIREBASE_MEASUREMENT_ID': r'G-[A-Z0-9]{6,10}',
        'VITE_FIREBASE_APPCHECK_SITE_KEY': r'6L[A-Za-z0-9_\-]{20,60}',
    }
    for key, pattern in fields.items():
        match = re.search(pattern, blob)
        if match:
            print(f'{key}={match.group(0)}')
    print('VITE_FIREBASE_AUTH_DOMAIN=fluxo-ath.firebaseapp.com')
    print('VITE_FIREBASE_PROJECT_ID=fluxo-ath')
    print('VITE_FIREBASE_STORAGE_BUCKET=fluxo-ath.firebasestorage.app')
    print('VITE_FIREBASE_MESSAGING_SENDER_ID=41695569839')

if __name__ == '__main__':
    main()
