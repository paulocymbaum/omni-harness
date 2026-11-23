import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../util.mjs';
import { PROFILE } from '../profile.mjs';
import { which } from '../tools.mjs';
import { result } from '../report.mjs';
import { step as stepBase, tail, scanScope } from './common.mjs';

// ================================================================ Java (F4 — perfil: runnerJava; camada 'java')
// Wrapper primeiro (./mvnw, ./gradlew), binário global como fallback; plugins de lint/estilo são
// opt-in (runnerJava.tools) e só invocam o que o projeto declara. Sem pom/gradle: aviso aberto.
const JAVA = PROFILE.runnerJava || {};
const CWD = JAVA.root || repoRoot();
// F6: MAVEN_OPTS/GRADLE_OPTS/JAVA_HOME via perfil alcançam build/test/lint (wrapper incluso).
const JAVA_ENV = JAVA.env || {};
// Wrapper transparente do step: mescla o env do perfil em qualquer chamada (mesma assinatura).
const step = (...a) => {
  const opts = a[5] || {};
  return stepBase(a[0], a[1], a[2], a[3], a[4], { ...opts, env: { ...JAVA_ENV, ...opts.env } });
};

export const javaScope = (entries) => scanScope(entries, JAVA.root, /\.java$|pom\.xml$|build\.gradle(\.kts)?$|gradle\.lockfile$/);

const MVN_GOALS = { spotless: 'spotless:check', checkstyle: 'checkstyle:check', pmd: 'pmd:check', spotbugs: 'spotbugs:check' };
const GRADLE_TASKS = { spotless: 'spotlessCheck', checkstyle: 'checkstyleMain', pmd: 'pmdMain', spotbugs: 'spotbugsMain' };

export function lintGoal(tool, buildTool) {
  if (buildTool === 'gradle') return GRADLE_TASKS[tool] || null;
  return MVN_GOALS[tool] || null;
}

/** Build system do projeto (pom.xml/build.gradle) e o comando: wrapper primeiro, global depois. */
export function detectBuildTool(exists, globalHas) {
  if (exists(path.join(CWD, 'pom.xml'))) return { tool: 'maven', cmd: exists(path.join(CWD, 'mvnw')) ? './mvnw' : globalHas('mvn') ? 'mvn' : null };
  const gradle = exists(path.join(CWD, 'build.gradle')) || exists(path.join(CWD, 'build.gradle.kts'));
  if (gradle) return { tool: 'gradle', cmd: exists(path.join(CWD, 'gradlew')) ? './gradlew' : globalHas('gradle') ? 'gradle' : null };
  return null;
}

export const mavenBuildArgs = () => ['-q', '-DskipTests', 'package'];

/** Módulos Maven (runnerJava.modules: prefixo de path → módulo) tocados pelos arquivos alterados. */
export function touchedModules(files) {
  const mapa = JAVA.modules || {};
  const mods = new Set();
  for (const f of files) {
    for (const prefixo of Object.keys(mapa)) {
      if (f.startsWith(prefixo)) mods.add(mapa[prefixo]);
    }
  }
  return [...mods];
}

export const mavenTestArgs = (modules) => (modules.length ? ['-pl', modules.join(','), '-am', 'test'] : ['test']);

export const gradleTestArgs = () => ['test', '--console=plain', '-q'];

export function javaRoutine(entries, out, budget, full) {
  const scope = javaScope(entries);
  if (!scope.length) return;
  const bt = detectBuildTool((p) => fs.existsSync(p), (t) => Boolean(which(t)));
  if (!bt) {
    out.push(result('ferramentas', 'warn', 'tool.delegated', { what: 'Build e testes Java', reason: 'nem pom.xml nem build.gradle no root do perfil', workflow: JAVA.workflow || 'CI do projeto' }));
    return;
  }
  if (!which('java')) {
    out.push(result('ferramentas', 'warn', 'tool.missing', { tool: 'java', impact: 'Build e testes Java não medidos (JDK ausente).' }));
    return;
  }
  if (!bt.cmd) {
    out.push(result('ferramentas', 'warn', 'tool.delegated', { what: `Build e testes Java (${bt.tool})`, reason: 'sem wrapper no projeto e sem binário global', workflow: JAVA.workflow || 'CI do projeto' }));
    return;
  }
  javaBuild(bt, out, budget);
  javaTest(bt, scope, out, budget, full);
  javaLint(bt, out, budget);
}

function javaBuild(bt, out, budget) {
  const args = bt.tool === 'maven' ? mavenBuildArgs() : ['build', '-x', 'test', '--console=plain', '-q'];
  const r = step(out, budget, `${bt.tool} build`, bt.cmd, args, { cwd: CWD, capMs: 600_000 });
  if (!r) return;
  out.push(r.code === 0
    ? result('tipos', 'pass', 'build.pass', { tool: bt.tool, scope: 'Java' })
    : result('tipos', 'fail', 'build.fail', { tool: bt.tool, scope: 'Java', tail: tail(r.stdout + r.stderr) }));
}

function javaTest(bt, scope, out, budget, full) {
  const modulos = full ? [] : touchedModules(scope.map((e) => e.path));
  const args = bt.tool === 'maven' ? mavenTestArgs(modulos) : gradleTestArgs();
  const r = step(out, budget, `${bt.tool} test`, bt.cmd, args, { cwd: CWD, capMs: full ? 900_000 : 600_000 });
  if (!r) return;
  const detail = bt.tool === 'maven' && modulos.length ? `-pl ${modulos.join(',')}` : (full ? 'suíte inteira' : 'módulos tocados ou suíte');
  out.push(r.code === 0
    ? result('testes', 'pass', 'tests.pass', { scope: 'Java', detail })
    : result('testes', 'fail', 'tests.fail', { scope: 'Java', detail, tail: tail(r.stdout + r.stderr) }));
}

/** Plugins opt-in (runnerJava.tools): spotless/checkstyle/pmd/spotbugs — o que o perfil declara. */
function javaLint(bt, out, budget) {
  const tools = JAVA.tools || [];
  for (const tool of tools) {
    const goal = lintGoal(tool, bt.tool);
    if (!goal) continue;
    const r = step(out, budget, `${bt.tool} ${goal}`, bt.cmd, bt.tool === 'maven' ? ['-q', goal] : [goal], { cwd: CWD, capMs: 300_000 });
    if (!r) continue;
    out.push(r.code === 0
      ? result('lint', 'pass', 'lint.pass', { tool, scope: `Java (${bt.tool})` })
      : result('lint', 'fail', 'lint.fail', { tool, scope: `Java (${bt.tool})`, tail: tail(r.stdout + r.stderr) }));
  }
}
