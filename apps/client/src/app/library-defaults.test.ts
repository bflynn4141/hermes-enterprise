// Every library component the client renders, given an empty server payload,
// must draw nothing the server did not send.
//
// The bug this is written against: a turn whose reply was the word "testing"
// showed "3 sources" and offered "Show the application evidence" and "Draft a
// follow-up for missing details". Nothing had gone wrong in the client — those
// are `StreamingText`'s *default props*, and the client had passed neither
// `sources` nor `followUps`, so the gallery's fixtures rendered as if they were
// this workspace's. Fifteen of the twenty-one components have a default like
// that, and a default that is a plausible sentence about applicants is the most
// dangerous kind of placeholder in a product whose whole claim is that what it
// shows happened (decision C42).
//
// Two halves, because one of them alone is not enough:
//
//   the source scan   every call site in `src/` is read, and every prop on the
//                     forbidden list has to be present. This is what catches a
//                     *new* call site that forgets one — a render test cannot,
//                     because it does not know the call site exists.
//   the render        each component is rendered to static markup with the
//                     empty payload, and the fixture strings are asserted
//                     absent. This is what catches a prop that is passed but
//                     does not actually suppress the fixture.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ApprovalCard,
  CodeBlock,
  ContextCards,
  DiffTable,
  FilterTable,
  FineTuneCard,
  Flowchart,
  InsightCards,
  RecommendationCard,
  RecordsTable,
  SearchList,
  SelectionActions,
  SidebarNav,
  TaskRows,
  ThinkingState,
  ToolChips,
} from '@hermes/motion-components';

const srcDir = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The props whose defaults are fixtures, per component.
 *
 * Read off the library's own signatures. A prop is on this list when omitting
 * it draws somebody's name, a file that does not exist, or a sentence about an
 * applicant.
 */
const REQUIRED: Readonly<Record<string, readonly string[]>> = {
  ApprovalCard: ['questions'],
  CodeBlock: ['lines', 'filename', 'diff'],
  ContextCards: ['chunks'],
  DiffTable: ['rows', 'columns', 'addedRow'],
  FilterTable: ['rows'],
  FineTuneCard: ['fields', 'options'],
  Flowchart: ['steps', 'edges'],
  InsightCards: ['pages'],
  RecommendationCard: ['options'],
  RecordsTable: ['rows'],
  SearchList: ['items', 'labels'],
  SelectionActions: ['actions', 'text'],
  SidebarNav: ['navItems', 'recents', 'workspace', 'footerLabel'],
  StreamingText: ['content', 'sources', 'followUps'],
  TaskRows: ['rows'],
  ThinkingState: ['rows', 'additionalSources'],
  ToolChips: ['steps', 'diffs', 'diffLines'],
};

/** Sentences and names that exist only in the library's fixtures. */
const FIXTURES = [
  'Show the application evidence',
  'Draft a follow-up for missing details',
  '3 sources',
  'Leah and Owen are ready for your review',
  'Partner criteria',
  'partner-review.ts',
  'review-notes.md',
  'follow-ups.md',
  'screening.json',
  'Maya Chen',
  'Owen Brooks',
  'Checking applications',
  'Review ready',
  'Reading partner criteria',
  'Hermes integration partners',
  'Read applications',
  'reviewPartner',
  'Admission review',
  'npm run verify',
] as const;

/**
 * The opening tags for one component in one file.
 *
 * Written by hand rather than with a regex because JSX props are full of `>`:
 * `items={list.map((s) => s.title)}` ends a lazy `<Tag …?>` match four props
 * early, and the audit then reports a prop that is right there. The scanner
 * tracks brace depth and string quoting and stops at the `>` that actually
 * closes the tag.
 */
export function openingTags(source: string, component: string): string[] {
  const tags: string[] = [];
  const opener = new RegExp(`<${component}(?![A-Za-z0-9_])`, 'g');
  for (const match of source.matchAll(opener)) {
    let depth = 0;
    let quote: string | null = null;
    let i = (match.index ?? 0) + match[0].length;
    for (; i < source.length; i += 1) {
      const ch = source[i]!;
      if (quote) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '>' && depth === 0) break;
    }
    tags.push(source.slice(match.index ?? 0, i + 1));
  }
  return tags;
}

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('no call site relies on a fixture default', () => {
  const files = sources(srcDir);

  for (const [component, props] of Object.entries(REQUIRED)) {
    it(`${component}: every usage passes ${props.join(', ')}`, () => {
      const missing: string[] = [];
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        for (const tag of openingTags(text, component)) {
          for (const prop of props) {
            if (!new RegExp(`\\b${prop}=`).test(tag)) {
              missing.push(`${file.slice(srcDir.length + 1)} · <${component}> is missing ${prop}`);
            }
          }
        }
      }
      expect(missing).toEqual([]);
    });
  }
});

/** What each component is handed when the server has sent nothing at all. */
const EMPTY_PAYLOAD: Readonly<Record<string, Record<string, unknown>>> = {
  ApprovalCard: { questions: [{ q: 'Which one?', type: 'radio', options: ['a', 'b'] }], labels: { continue: 'Continue', send: 'Send', sentMessage: 'Sent' } },
  CodeBlock: { lines: [''], filename: 'code', diff: [], variant: 'Code' },
  ContextCards: { chunks: [], labels: { header: 'Pages fetched', count: '0' } },
  DiffTable: { rows: [], columns: ['a', 'b', 'c'], addedRow: { key: 'k', id: '', dept: '', email: '', removed: false }, title: 'Proposed' },
  FilterTable: { rows: [] },
  FineTuneCard: { fields: [], options: [] },
  Flowchart: { steps: [], edges: [] },
  InsightCards: { pages: [] },
  RecommendationCard: { options: [], labels: { title: 'What needs you next' } },
  RecordsTable: { rows: [] },
  SearchList: { items: [], labels: { placeholder: 'Search sessions…', ariaLabel: 'Search sessions', emptyTitle: 'No sessions', emptyHint: 'Start one.' } },
  SelectionActions: { actions: { primary: [], more: [] }, text: { lead: '', original: '', rewrite: '' }, explanation: '' },
  SidebarNav: { navItems: [], recents: [], workspace: { key: 'w', name: 'Workspace', monogram: 'W' }, footerLabel: 'You · 0 joined' },
  TaskRows: { rows: [] },
  ThinkingState: { rows: [], stage: 0, active: 'Working', done: 'Done · 0 steps', additionalSources: 0 },
  ToolChips: { steps: [], diffs: [], diffLines: {} },
};

const COMPONENTS: Readonly<Record<string, ComponentType<never>>> = {
  ApprovalCard,
  CodeBlock,
  ContextCards,
  DiffTable,
  FilterTable,
  FineTuneCard,
  Flowchart,
  InsightCards,
  RecommendationCard,
  RecordsTable,
  SearchList,
  SelectionActions,
  SidebarNav,
  TaskRows,
  ThinkingState,
  ToolChips,
} as unknown as Readonly<Record<string, ComponentType<never>>>;

describe('an empty payload draws no fixture', () => {
  for (const [name, component] of Object.entries(COMPONENTS)) {
    it(name, () => {
      const markup = renderToStaticMarkup(createElement(component, EMPTY_PAYLOAD[name] as never));
      for (const fixture of FIXTURES) expect(markup, `${name} rendered "${fixture}"`).not.toContain(fixture);
    });
  }
});

// `StreamingText` has no entry above because the client no longer renders it
// (decision C41): `RunSurface` draws the stream through `IrisText`, which is
// the same component the finished message uses and has no props to default.
it('StreamingText is not imported anywhere in the client', () => {
  // The name still appears in two comments explaining why it is gone; the
  // assertion is about the import, which is the thing that would render it.
  const offenders = sources(srcDir).filter((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .some((line) => line.startsWith('import ') && /\bStreamingText\b/.test(line)),
  );
  expect(offenders).toEqual([]);
});
