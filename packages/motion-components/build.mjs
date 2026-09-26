import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import postcss from 'postcss';
import prefix from 'postcss-prefix-selector';
import {execFileSync} from 'node:child_process';
await fs.mkdir('dist',{recursive:true});
await fs.mkdir('public',{recursive:true});
await fs.copyFile('LICENSE.beautiful-ui','dist/LICENSE.beautiful-ui');
// Build the gallery first. Tailwind scans the bundle and its source map so a
// fresh checkout produces the same utility set as the original package.
await esbuild.build({entryPoints:['demo/main.tsx'],bundle:true,format:'esm',target:['es2022'],jsx:'automatic',outfile:'public/app.js',minify:true,sourcemap:true,alias:{'@':path.resolve('src')},define:{'process.env.NODE_ENV':'"production"'},logLevel:'info'});
execFileSync(process.execPath,['node_modules/@tailwindcss/cli/dist/index.mjs','-i','src/foundation.css','-o','dist/utility.css','--minify'],{stdio:'inherit'});
const input=await fs.readFile('dist/utility.css','utf8');
const scoped=await postcss([prefix({prefix:'.hermes-ui',transform:(p,s,pref)=>{
 if(s===':root'||s===':host'||s==='html'||s==='body')return '.hermes-ui';
 return s.startsWith('.') ? pref+','+p+s : pref;
}})]).process(input,{from:undefined});
const theme=await fs.readFile('src/theme.css','utf8');
await fs.writeFile('dist/components.css',scoped.css+'\n'+theme);
await fs.copyFile('dist/components.css','public/components.css');
await esbuild.build({entryPoints:['src/index.ts'],bundle:true,format:'esm',target:['es2022'],jsx:'automatic',outfile:'dist/index.js',banner:{js:'/*! Adapted from Beautiful UI, Copyright (c) 2026 Shane Levine. MIT. See LICENSE.beautiful-ui. */'},packages:'external',alias:{'@':path.resolve('src')},logLevel:'info'});
await fs.copyFile('demo/gallery.css','public/gallery.css');
execFileSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.build.json'],{stdio:'inherit'});
for (const entry of await fs.readdir('dist/types',{recursive:true})) {
  if (!entry.endsWith('.d.ts')) continue;
  const declaration = path.join('dist/types',entry);
  const source = await fs.readFile(declaration,'utf8');
  await fs.writeFile(declaration,source.replace(/[ \t]+$/gm,''));
}
console.log('Built gallery and reusable dist/index.js + components.css');
