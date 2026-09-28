// The design-system guard (docs/DESIGN.md, Design system rules).
//
// New features keep rebuilding what the primitives already do: a sentence
// where an empty state belongs, a hand-made tab row, an uppercase eyebrow.
// Review misses these, so this test reads the source and fails with the rule
// and the primitive to use instead. Most rules are patterns in the source; one
// renders EmptyState. All of it is fast and runs in `pnpm check:quick`.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EmptyState } from './ui/primitives.js';

const srcDir = dirname(dirname(fileURLToPath(import.meta.url)));

function walk(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path, ext);
    return path.endsWith(ext) && !/\.test\.tsx?$/.test(path) ? [path] : [];
  });
}

const rel = (path: string): string => relative(srcDir, path);
const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;
const views = walk(join(srcDir, 'app'), '.tsx').filter((file) => !file.endsWith(join('ui', 'primitives.tsx')));
const styles = walk(srcDir, '.css');

/** Every match of `pattern` in `files`, as `file:line  text`. */
function find(files: string[], pattern: RegExp): string[] {
  return files.flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    return [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))]
      .map((match) => `${rel(file)}:${lineOf(text, match.index ?? 0)}  ${match[0].replace(/\s+/g, ' ').slice(0, 100)}`);
  });
}

describe('design system', () => {
  it('shows an empty list, tab or section with EmptyState, never a bare sentence', () => {
    // An emptiness check followed by an element whose text starts "No"/"Nothing",
    // or any element whose whole text is "No … yet".
    const afterEmptyCheck = /(?:length === 0|\.length\s*\?|!\w+(?:\?\.)?\.length)\s*(?:\)\s*)?(?:\?|&&)\s*<(?:p|div|span|li)\b[^>]*>\s*(?:No|Nothing)\b/;
    const noYet = />\s*(?:No|Nothing) [^<{]*\byet\b\.?\s*<\//;
    const found = [...find(views, afterEmptyCheck), ...find(views, noYet)];
    expect(found, 'Use <EmptyState icon title /> (add `compact` inside a card or popover) instead of a sentence.').toEqual([]);
  });

  it('centers an empty state and puts its action below the words', () => {
    const html = renderToStaticMarkup(createElement(EmptyState, { compact: true, icon: 'inbox', title: 'No inboxes yet', action: createElement('button', null, 'Add inbox') }));
    expect(html.indexOf('No inboxes yet')).toBeLessThan(html.indexOf('Add inbox'));
    expect(html).toContain('empty-state compact');
  });

  it('gives Admin pages no floating description under their tabs', () => {
    // Pages start with AdminPageHeader, which has no description slot. Only a
    // drill-down (one agent, one role, one approval) has a visible title, and
    // with it the record's own description.
    const drillDowns = ['AdminAgents.tsx', 'AdminApprovals.tsx', 'AdminRoles.tsx'];
    const found = find(views.filter((file) => !drillDowns.some((name) => file.endsWith(name))), /className="admin-detail-heading"/);
    expect(found, 'Start an Admin page with <AdminPageHeader title actions />; put explanations in docs, not under the tabs.').toEqual([]);
  });

  it('does not badge a connection as "Not connected"', () => {
    // The Connect button already says it (docs/DESIGN.md, Connections).
    expect(find(views, /<Pill\b[^>]*>\s*(?:\{\s*)?['"]?Not connected/), 'Show a badge only for "Needs attention"; see AdminSettingsCard `badge`.').toEqual([]);
  });

  it('builds tab rows only with the Tabs primitive', () => {
    expect(find(views, /role="tablist"/), 'Use <Tabs> from ui/primitives for a row of tabs.').toEqual([]);
  });

  it('has no uppercase eyebrow text', () => {
    // An invoice's printed "Bill to" and the development-only account switcher
    // are the two exceptions; neither is product chrome.
    const allowed = new Set(['.doc-label', '.popover.account-menu .dev-switcher .p-meta']);
    const found = styles.flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return [...text.matchAll(/([^{}\n]+)\{[^}]*text-transform:\s*uppercase/g)]
        .filter((match) => !allowed.has(match[1]!.trim()))
        .map((match) => `${rel(file)}:${lineOf(text, match.index ?? 0)}  ${match[1]!.trim()}`);
    });
    expect(found, 'Sentence case everywhere; no tiny uppercase labels.').toEqual([]);
  });

  it('does not add text smaller than 12px', () => {
    // A ratchet: existing sizes are being paid down, new ones may not be added.
    // Lower BASELINE when a change removes some; never raise it.
    const BASELINE = 258;
    const count = find(styles, /font-size:\s*(?:\d|1[01])(?:\.\d+)?px/).length;
    expect(count, `Text under 12px went from ${BASELINE} to ${count}. Use 12px or larger.`).toBeLessThanOrEqual(BASELINE);
  });
});
