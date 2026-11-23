// BIL-017-FLUXO-COMPLETO. Sete tipos e um híbrido: empresa, membro e merchant só no PostgreSQL (dublê da API); serviço, agendamento e pedido pelos handlers reais;
// site de verdade no Chromium, com Firestore e Auth emulados e o firestore.rules atual. Depois repete como intruso. Tudo fora de 127.0.0.1 é bloqueado.
// A sessão entra por localStorage, no formato de browserLocalPersistence, com token do Auth emulado: o site só tem login por Google e Apple.
// Contrato que este gate fixa, além da spec: abas em <nav aria-label="Módulos da empresa">, com um link por aba, na ordem de workspaceFor, e Insights e Plano depois.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, read } from '../bil-gate-helper.mjs';
import { PROJECT, collector, compileFunctions, freePort, loadHandlers, siteRequire, withEmulators } from '../bil-017-gate-helper.mjs';

const API_KEY = 'demo-bil017-key';
const API_HOST = 'api.bil017.invalid';
const GOLDEN = 'quality/test/delivery/fixtures/bil-017-workspace.golden.json';
const norm = (value) => String(value).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const MODULE = { dashboard: '', menu: 'menu', orders: 'operations', agenda: 'agenda', team: 'team', affiliates: 'affiliates' };
const FAMILIES = [
  ['FOOD_PLACE', []], ['SERVICE_PROVIDER', []], ['SELLER', []], ['VENUE', []], ['EVENT_ORGANIZER', []], ['DIGITAL_CREATOR', []], ['BRAND', []], ['FOOD_PLACE', ['47.81-4/00']],
];
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };

async function signUp(authHost, email) {
  const response = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'gate-senha-123', returnSecureToken: true }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return { uid: body.localId, email, idToken: body.idToken, refreshToken: body.refreshToken };
}

const persisted = (user) => ({
  uid: user.uid, email: user.email, emailVerified: true, isAnonymous: false, providerData: [], apiKey: API_KEY, appName: '[DEFAULT]',
  stsTokenManager: { refreshToken: user.refreshToken, accessToken: user.idToken, expirationTime: Date.now() + 3_500_000 },
  createdAt: String(Date.now()), lastLoginAt: String(Date.now()),
});

async function seedUser(db, user, businessIds) {
  await db.doc(`users/${user.uid}`).set({ uid: user.uid, displayName: 'Gate', username: `gate${user.uid.slice(0, 6)}`, profileCompleted: true, canonicalUid: user.uid });
  await db.doc(`users_private/${user.uid}`).set({ settings: { ugcTermsAcceptedAt: new Date() } });
  await db.doc(`accountContexts/${user.uid}`).set({ activeAccountKind: 'person', availableBusinessIds: businessIds });
}

/** O site lê a empresa ativa de accountContexts. No intruso, é o contexto forjado: quem barra é a regra, não a tela. */
const activate = (db, user, id) => db.doc(`accountContexts/${user.uid}`).set({ activeAccountKind: 'business', activeBusinessId: id }, { merge: true });

async function seedBusiness(db, id, user, primaryType, cnaes) {
  await db.doc(`businessProfiles/${id}`).set({
    tradeName: `Empresa ${id}`, legalName: `Empresa ${id}`, fluxoBusinessType: primaryType, cnaeMain: cnaes[0] ?? null, cnaeSecondary: cnaes.slice(1),
    ownerUids: [user.uid], statusCode: 'active', verificationLevel: 'none', trustScore: 0, ownerVerifiedCount: 1,
  });
  await db.doc(`businessProfiles/${id}/members/${user.uid}`).set({ uid: user.uid, businessId: id, role: 'ADMIN', status: 'active' });
}

/** Cria só o que o tipo mostra: com dado, o módulo oculto aparece (D3), e o gate não provaria a ocultação. */
async function register(call, id, uid, tabs, index) {
  const marks = { order: `Pedido ${id}`, service: `Servico ${id}`, item: `Item ${id}` };
  await call('empresasV1CreateOrder', uid, { merchantId: id, items: [{ name: marks.order, quantity: 2, price: 28.9 }], total: 57.8, customerName: 'Cliente Gate' });
  if (tabs.includes('agenda')) {
    const { service } = await call('empresasV1CreateService', uid, { merchantId: id, name: marks.service, durationMinutes: 45, price: 80 });
    await call('empresasV1CreateAppointment', uid, { merchantId: id, serviceId: service.id, startsAt: new Date(Date.now() + (index + 1) * 86_400_000).toISOString(), customerName: 'Cliente Gate' });
  }
  return marks;
}

function apiDouble(catalog, member) {
  const uidOf = (request) => {
    const token = (request.headers().authorization ?? '').replace('Bearer ', '');
    try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).user_id; } catch { return null; }
  };
  return async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const { pathname } = new URL(request.url());
    const id = /\/(?:merchants|businesses)\/([^/]+)/.exec(pathname)?.[1];
    const json = (status, body) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!id || !catalog[id]) return json(404, { error: { code: 'not_found' } });
    if (uidOf(request) !== member.uid) return json(403, { error: { code: 'business_access_denied' } });
    const now = new Date().toISOString();
    if (pathname.endsWith('/menu')) {
      const items = catalog[id].item ? [{ id: `i-${id}`, merchantId: id, categoryId: 'c1', name: catalog[id].item, description: null, price: 19.9, imageUrl: null, available: true, featured: false }] : [];
      return json(200, items.length ? [{ id: 'c1', merchantId: id, name: 'Categoria Gate', description: null, sequence: 0, active: true, items }] : []);
    }
    if (pathname.endsWith('/team')) return json(200, [{ uid: member.uid, businessId: id, role: 'ADMIN', status: 'active', permissions: [], displayName: 'Membro Gate', username: null, photoUrl: null }]);
    return json(200, { id, businessId: id, name: `Empresa ${id}`, type: 'other', active: true, ownerUid: member.uid, createdAt: now, updatedAt: now });
  };
}

async function openContext(browser, site, user, catalog, member) {
  const context = await browser.newContext({ baseURL: site, locale: 'pt-BR' });
  const blocked = [];
  await context.route('**/*', (route) => {
    const { hostname, pathname } = new URL(route.request().url());
    if (pathname.endsWith('/exchangeAliasSessionForCanonicalUser')) {
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ result: { needsExchange: false } }) });
    }
    if (hostname === '127.0.0.1') return route.continue();
    if (hostname === API_HOST) return route.fallback();
    blocked.push(hostname);
    return route.abort();
  });
  await context.route(`http://${API_HOST}/**`, apiDouble(catalog, member));
  await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [`firebase:authUser:${API_KEY}:[DEFAULT]`, JSON.stringify(persisted(user))]);
  return { context, page: await context.newPage(), blocked };
}

const bodyOf = async (page, marker) => {
  await page.getByText(marker, { exact: false }).first().waitFor({ timeout: 8_000 });
  return page.locator('body').innerText();
};

async function assertMember(page, check, id, expected, marks, tabs) {
  await page.goto(`/app/business/${id}`);
  const nav = page.getByRole('navigation', { name: 'Módulos da empresa' });
  await nav.waitFor({ timeout: 12_000 });
  const links = (await nav.getByRole('link').allInnerTexts()).map(norm);
  const wanted = expected.tabs.map((t) => norm(t.label));
  check(`${id}: abas do tipo, na ordem`, links.slice(0, wanted.length).join() === wanted.join(), `${links.join()} em vez de ${wanted.join()}`);
  check(`${id}: Insights e Plano para todos`, links.includes('insights') && links.includes('plano'), links.join());
  check(`${id}: painel do tipo`, norm(await page.locator('body').innerText()).includes(norm(expected.dashboardTitle)), expected.dashboardTitle);
  await page.goto(`/app/business/${id}/${MODULE.orders}`);
  const orders = await bodyOf(page, marks.order);
  check(`${id}: pedido com total`, orders.includes('57,80'));
  if (tabs.includes('agenda')) {
    await page.goto(`/app/business/${id}/${MODULE.agenda}`);
    const agenda = await bodyOf(page, marks.service);
    check(`${id}: serviço com duração, preço e agendamento`, /45\s*min/.test(agenda) && agenda.includes('80,00') && agenda.includes('Cliente Gate'));
  }
  if (tabs.includes('menu')) {
    await page.goto(`/app/business/${id}/${MODULE.menu}`);
    await bodyOf(page, marks.item);
  }
}

async function assertIntruder(page, check, id, marks) {
  await page.goto(`/app/business/${id}/${MODULE.orders}`);
  await page.getByText(/não foi possível carregar|permiss/i).first().waitFor({ timeout: 8_000 }).catch(() => check(`${id}: intruso vê o erro`, false, 'nenhum erro na tela'));
  check(`${id}: intruso não vê dado`, !(await page.locator('body').innerText()).includes(marks.order));
}

function startSite(hosts, port, envDir) {
  const site = path.join(ROOT, 'ofluxo_site');
  const child = spawn('node', [path.join(path.dirname(fileURLToPath(import.meta.url)), 'vite-server.mjs')], {
    cwd: envDir, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, NODE_ENV: 'development', BIL_SITE: site, BIL_ENV_DIR: envDir, BIL_PORT: String(port), BIL_FIRESTORE_PORT: String(hosts.firestorePort), BIL_AUTH_PORT: String(hosts.authPort),
      VITE_USE_EMULATORS: 'true', VITE_FIREBASE_API_KEY: API_KEY, VITE_FIREBASE_AUTH_DOMAIN: 'localhost', VITE_FIREBASE_PROJECT_ID: PROJECT, VITE_FIREBASE_STORAGE_BUCKET: `${PROJECT}.appspot.com`,
      VITE_FIREBASE_APP_ID: '1:1:web:bil017', VITE_FIREBASE_MEASUREMENT_ID: '', VITE_FIREBASE_APPCHECK_SITE_KEY: '', VITE_FLUXO_API_BASE_URL: `http://${API_HOST}/api/v1/`,
    },
  });
  const ready = new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error(`site não subiu em 30 s:\n${log.slice(-1500)}`)), 30_000);
    const read = (chunk) => { log += chunk; if (log.includes('BIL017_SITE_READY')) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`site saiu com ${code}:\n${log.slice(-1500)}`)); });
  });
  return { child, ready };
}

export async function runFluxoCompleto() {
  const { check, done } = collector();
  const golden = JSON.parse(read(GOLDEN)).cases;
  const { lib, cleanup } = compileFunctions();
  const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bil-017-site-'));
  try {
    await withEmulators(['auth', 'firestore'], async (hosts) => {
      const { db, call } = loadHandlers(lib, hosts);
      let siteProcess = null;
      let browser = null;
      try {
        const member = await signUp(hosts.auth, 'membro@gate.test');
        const intruder = await signUp(hosts.auth, 'intruso@gate.test');
        const ids = FAMILIES.map((_, index) => `biz-${index}`);
        await seedUser(db, member, ids);
        await seedUser(db, intruder, []);
        const catalog = {};
        const plan = [];
        for (const [index, [primaryType, cnaes]] of FAMILIES.entries()) {
          const id = ids[index];
          const expected = golden.find((c) => c.primaryType === primaryType && c.cnaes.join() === cnaes.join())?.expected;
          assert.ok(expected, `golden sem ${primaryType} ${cnaes}`);
          const tabs = expected.tabs.map((t) => t.key);
          await seedBusiness(db, id, member, primaryType, cnaes);
          const marks = await register(call, id, member.uid, tabs, index);
          catalog[id] = { item: tabs.includes('menu') ? marks.item : null };
          plan.push({ id, expected, marks, tabs });
        }
        const port = await freePort();
        const started = startSite(hosts, port, envDir);
        siteProcess = started.child;
        await started.ready;
        const { chromium } = siteRequire('@playwright/test');
        browser = await chromium.launch();
        const site = `http://127.0.0.1:${port}`;
        const asMember = await openContext(browser, site, member, catalog, member);
        for (const { id, expected, marks, tabs } of plan) {
          await activate(db, member, id);
          await assertMember(asMember.page, check, id, expected, marks, tabs);
        }
        const asIntruder = await openContext(browser, site, intruder, catalog, member);
        for (const { id, marks } of plan) {
          await activate(db, intruder, id);
          await assertIntruder(asIntruder.page, check, id, marks);
        }
        check('nenhuma chamada saiu de 127.0.0.1', asMember.blocked.length + asIntruder.blocked.length === 0, [...new Set([...asMember.blocked, ...asIntruder.blocked])].join());
      } finally {
        await browser?.close();
        siteProcess?.kill('SIGTERM');
        await db.terminate();
      }
    });
  } finally {
    cleanup();
    fs.rmSync(envDir, { recursive: true, force: true });
  }
  done();
}
