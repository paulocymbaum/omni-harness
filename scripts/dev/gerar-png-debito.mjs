// Gera docs/assets/debito-tecnico-ia.png: relação entre débito técnico acumulado e volume de
// código gerado por IA, sem Poka-yoke (débito compõe) e com Poka-yoke (defeito bloqueado no
// passo em que nasce e realimentado ao modelo). Determinístico: ffmpeg + drawbox/drawtext,
// sem dependências. Rodar do root: node scripts/dev/gerar-png-debito.mjs
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const W = 960;
const H = 540;
const X0 = 100;
const X1 = 880;
const Y0 = 120;
const Y1 = 440;
const DEBT_MAX = 380;
const FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

const px = (x) => Math.round(X0 + x * (X1 - X0));
const py = (divida) => Math.round(Y1 - (divida / DEBT_MAX) * (Y1 - Y0));

// Curvas: sem Poka-yoke o débito compõe (potência); com Poka-yoke cresce pouco e estabiliza.
const curvaSem = (x) => 30 + (DEBT_MAX - 50) * Math.pow(x, 1.9);
const curvaCom = (x) => 30 + 60 * Math.pow(x, 1.4);

const pontos = (curva, cor) => {
  const f = [];
  const N = 70;
  for (let i = 0; i <= N; i += 1) {
    const x = i / N;
    f.push(`drawbox=x=${px(x) - 1}:y=${py(curva(x)) - 1}:w=4:h=4:color=${cor}:t=fill`);
  }
  return f;
};

const texto = (op) =>
  `drawtext=fontfile=${op.bold ? FONT_BOLD : FONT}:text='${op.t}':fontsize=${op.size}:fontcolor=${op.cor}:x=${op.x}:y=${op.y}`;

const filtros = [
  texto({ t: 'Technical debt vs. AI-generated code volume', size: 30, x: 40, y: 28, cor: 'black', bold: true }),
  texto({ t: 'Poka-yoke: a defect is blocked where it is born and fed back to the model', size: 19, x: 40, y: 70, cor: '0x333333' }),
  texto({ t: 'accumulated technical debt ↑', size: 19, x: 16, y: 92, cor: '0x555555' }),
  `drawbox=x=${X0}:y=${Y0}:w=2:h=${Y1 - Y0}:color=black:t=fill`,
  `drawbox=x=${X0}:y=${Y1}:w=${X1 - X0}:h=2:color=black:t=fill`,
  ...pontos(curvaSem, '0xB3261E'),
  ...pontos(curvaCom, '0x1B7A3D'),
  `drawbox=x=${X1 - 300}:y=${py(curvaSem(0.93)) - 6}:w=26:h=5:color=0xB3261E:t=fill`,
  texto({ t: 'without Poka-yoke', size: 19, x: X1 - 268, y: py(curvaSem(0.93)) - 16, cor: '0xB3261E', bold: true }),
  `drawbox=x=${X1 - 300}:y=${py(curvaCom(0.93)) - 6}:w=26:h=5:color=0x1B7A3D:t=fill`,
  texto({ t: 'with Poka-yoke', size: 19, x: X1 - 268, y: py(curvaCom(0.93)) - 16, cor: '0x1B7A3D', bold: true }),
  texto({ t: 'AI-generated code volume →', size: 20, x: X1 - 330, y: Y1 + 26, cor: '0x555555' }),
  texto({ t: 'same delivery pace', size: 17, x: px(0.18), y: Y1 + 10, cor: '0x777777' }),
];

mkdirSync(path.join(RAIZ, 'docs', 'assets'), { recursive: true });
const r = spawnSync('ffmpeg', [
  '-y', '-loglevel', 'error',
  '-f', 'lavfi', '-i', `color=white:s=${W}x${H}:d=1`,
  '-vf', filtros.join(','),
  '-frames:v', '1',
  path.join(RAIZ, 'docs', 'assets', 'debito-tecnico-ia.png'),
], { stdio: 'inherit' });
if (r.status !== 0) process.exit(1);
