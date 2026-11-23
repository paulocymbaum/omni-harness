// Gate BIL-008-E2E-ROTAS. Só Chromium e servidor de desenvolvimento em porta própria: nada de build, e nenhum servidor reaproveitado.
// Objeto puro: este arquivo fica fora de ofluxo_site e não enxerga @playwright/test.
const port = Number(process.env.BIL_GATE_PORT ?? 41730);
export default {
  testDir: process.env.BIL_GATE_E2E_DIR,
  timeout: 45_000,
  outputDir: process.env.BIL_GATE_OUTPUT,
  use: { baseURL: `http://127.0.0.1:${port}`, browserName: 'chromium' },
  webServer: {
    command: `NODE_ENV=development npx vite --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: process.env.BIL_GATE_SITE,
    port,
    reuseExistingServer: false,
    timeout: 45_000,
  },
};
