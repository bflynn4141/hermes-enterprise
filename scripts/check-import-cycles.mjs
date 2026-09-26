#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(process.cwd(), 'apps/worker/src');
const extensions = ['.ts', '.tsx', '.mts', '.cts'];

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return extensions.includes(extname(entry.name)) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

function resolveLocalImport(importer, specifier) {
  if (!specifier.startsWith('.')) return null;
  const unresolved = resolve(dirname(importer), specifier);
  const withoutJsExtension = unresolved.replace(/\.(?:mjs|cjs|js)$/, '');
  const candidates = [
    ...extensions.map((extension) => `${withoutJsExtension}${extension}`),
    ...extensions.map((extension) => join(unresolved, `index${extension}`)),
  ];
  return candidates.find(existsSync) ?? null;
}

function runtimeImports(file) {
  const source = readFileSync(file, 'utf8');
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
  const imports = [];

  for (const statement of syntax.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      if (
        clause &&
        !clause.name &&
        clause.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((binding) => binding.isTypeOnly)
      ) continue;
      imports.push(statement.moduleSpecifier.text);
      continue;
    }

    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      if (statement.isTypeOnly) continue;
      if (
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.length > 0 &&
        statement.exportClause.elements.every((binding) => binding.isTypeOnly)
      ) continue;
      imports.push(statement.moduleSpecifier.text);
    }
  }
  return imports;
}

const files = sourceFiles(root);
const graph = new Map(files.map((file) => [file, []]));
for (const file of files) {
  for (const specifier of runtimeImports(file)) {
    const dependency = resolveLocalImport(file, specifier);
    if (dependency && graph.has(dependency)) graph.get(file).push(dependency);
  }
}

let nextIndex = 0;
const indices = new Map();
const lowLinks = new Map();
const stack = [];
const onStack = new Set();
const cycles = [];

function connect(file) {
  indices.set(file, nextIndex);
  lowLinks.set(file, nextIndex);
  nextIndex += 1;
  stack.push(file);
  onStack.add(file);

  for (const dependency of graph.get(file)) {
    if (!indices.has(dependency)) {
      connect(dependency);
      lowLinks.set(file, Math.min(lowLinks.get(file), lowLinks.get(dependency)));
    } else if (onStack.has(dependency)) {
      lowLinks.set(file, Math.min(lowLinks.get(file), indices.get(dependency)));
    }
  }

  if (lowLinks.get(file) !== indices.get(file)) return;
  const component = [];
  let member;
  do {
    member = stack.pop();
    onStack.delete(member);
    component.push(member);
  } while (member !== file);

  const selfCycle = component.length === 1 && graph.get(component[0]).includes(component[0]);
  if (component.length > 1 || selfCycle) cycles.push(component);
}

for (const file of files) if (!indices.has(file)) connect(file);

if (cycles.length === 0) {
  console.log(`No runtime import cycles in ${relative(process.cwd(), root)} (${files.length} modules).`);
  process.exit(0);
}

console.error(`Found ${cycles.length} runtime import cycle${cycles.length === 1 ? '' : 's'}:`);
for (const component of cycles) {
  console.error('');
  for (const file of component.sort()) console.error(`  - ${relative(process.cwd(), file)}`);
}
process.exit(1);
