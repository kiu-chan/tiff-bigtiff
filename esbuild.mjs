import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  minify: production,
  sourcemap: production ? false : 'linked',
  logLevel: 'info',
  legalComments: 'none',
};

const builds = [
  // Extension host (Node.js)
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
  },
  // Webview UI
  {
    ...common,
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/webview/main.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome114',
  },
  // Decoder worker running inside the webview
  {
    ...common,
    entryPoints: ['src/webview/worker.ts'],
    outfile: 'dist/webview/worker.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome114',
  },
];

if (watch) {
  for (const options of builds) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  }
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
