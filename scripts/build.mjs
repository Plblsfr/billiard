// Construit le site statique dans dist/ :
//   dist/index.html
//   dist/assets/<empreinte>/{styles.css, js/…}   (cache immuable)
//   dist/{favicon.svg, manifest.webmanifest, robots.txt}
// La vue 3D (three.js) est regroupée et minifiée par esbuild en un seul fichier, chargé à la demande.
// Option --watch : reconstruit à chaque modification et sert dist/ sur http://localhost:5173
import { execFileSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
const tmp = join(root, '.tsbuild');

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function tscBin() {
  const local = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  return existsSync(local) ? [process.execPath, [local]] : ['tsc', []];
}

export function build() {
  const t0 = Date.now();
  rmSync(tmp, { recursive: true, force: true });
  const [cmd, pre] = tscBin();
  execFileSync(cmd, [...pre, '-p', join(root, 'tsconfig.build.json')], { stdio: 'inherit', cwd: root });

  // rendu 3D : three.js n'a pas de version minifiée, on ne garde que ce qui sert
  const view3d = join(tmp, 'render', 'renderer3d.js');
  buildSync({
    entryPoints: [view3d],
    outfile: view3d,
    allowOverwrite: true,
    bundle: true,
    format: 'esm',
    minify: true,
    target: 'es2022',
    legalComments: 'eof',
    logLevel: 'warning',
  });

  const css = readFileSync(join(root, 'web', 'styles.css'));
  const jsFiles = walk(tmp).filter((f) => f.endsWith('.js'));
  const hash = createHash('sha256');
  hash.update(css);
  for (const f of jsFiles.sort()) hash.update(relative(tmp, f)).update(readFileSync(f));
  const id = hash.digest('hex').slice(0, 10);
  const assets = join(out, 'assets', id);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(assets, 'js'), { recursive: true });
  for (const f of jsFiles) {
    const dest = join(assets, 'js', relative(tmp, f));
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(f, dest);
  }
  writeFileSync(join(assets, 'styles.css'), css);
  cpSync(join(root, 'public'), out, { recursive: true });
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8').replaceAll('%ASSETS%', `/assets/${id}`);
  writeFileSync(join(out, 'index.html'), html);
  writeFileSync(join(out, 'version.json'), JSON.stringify({ version: process.env.APP_VERSION || 'dev', assets: id }) + '\n');
  rmSync(tmp, { recursive: true, force: true });
  console.log(`dist/ prêt (assets/${id}) en ${Date.now() - t0} ms`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    build();
  } catch {
    if (!process.argv.includes('--watch')) process.exit(1);
  }
  if (process.argv.includes('--watch')) {
    const { serve } = await import('./serve.mjs');
    serve(out, Number(process.env.PORT) || 5173);
    let timer = null;
    for (const dir of ['src', 'web', 'public']) {
      watch(join(root, dir), { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          try {
            build();
          } catch {
            /* l'erreur TypeScript est déjà affichée */
          }
        }, 150);
      });
    }
  }
}
