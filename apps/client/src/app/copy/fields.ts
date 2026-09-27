// Structured data (tool arguments, tool results) as labelled plain values.
//
// docs/DESIGN.md forbids JSON, identifiers and snake_case on screen. A person
// reviewing what an agent was given or got back needs the values, labelled in
// words; the ids and the braces belong in logs.

export interface ReadableField {
  readonly label: string;
  readonly value: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^(sha256:)?[0-9a-f]{32,}$/i;
const MAX_FIELDS = 40;
const MAX_VALUE = 600;

/** "to_address" → "To address", "createdAt" → "Created at". */
export function fieldLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Value';
}

/** A key that only ever carries an identifier. */
const isIdentifierKey = (key: string): boolean => /(^|_)(id|ids|uuid|hash|sha256|digest|key|token|cursor)$/i.test(key) || /Id$/.test(key);

/** A value that is an identifier, whatever its key says. */
const isIdentifierValue = (value: unknown): boolean => typeof value === 'string' && (UUID.test(value.trim()) || HASH.test(value.trim()));

function clip(text: string): string {
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1).trimEnd()}…` : text;
}

function scalar(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return Number.isFinite(value) ? value.toLocaleString() : '—';
  if (typeof value === 'string') return isIdentifierValue(value) ? null : clip(value);
  return null;
}

function inline(value: unknown, depth: number): string | null {
  const plain = scalar(value);
  if (plain !== null || typeof value === 'string') return plain;
  if (Array.isArray(value)) {
    const parts = value.map((item) => inline(item, depth + 1)).filter((item): item is string => Boolean(item));
    return parts.length ? clip(parts.join(', ')) : value.length ? null : 'None';
  }
  if (value && typeof value === 'object') {
    if (depth > 2) return null;
    const parts = Object.entries(value as Record<string, unknown>)
      .filter(([key, item]) => !isIdentifierKey(key) && !isIdentifierValue(item))
      .map(([key, item]) => {
        const text = inline(item, depth + 1);
        return text ? `${fieldLabel(key)}: ${text}` : null;
      })
      .filter((item): item is string => Boolean(item));
    return parts.length ? clip(parts.join(' · ')) : null;
  }
  return null;
}

/**
 * Top-level fields as label/value pairs. Nested objects flatten into their
 * parent's value; identifiers are left out.
 */
export function readableFields(value: unknown): ReadableField[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== 'object' || Array.isArray(value)) {
    const text = inline(value, 0);
    return text ? [{ label: Array.isArray(value) ? 'Items' : 'Value', value: text }] : [];
  }
  return Object.entries(value as Record<string, unknown>)
    .filter(([key, item]) => !isIdentifierKey(key) && !isIdentifierValue(item))
    .map(([key, item]) => ({ label: fieldLabel(key), value: inline(item, 1) }))
    .filter((field): field is ReadableField => field.value !== null)
    .slice(0, MAX_FIELDS);
}

/**
 * A tool's argument or result string: JSON becomes fields, anything else is
 * shown as the text it is.
 */
export function readableText(raw: string | null | undefined): { fields: ReadableField[]; text: string | null } {
  const text = (raw ?? '').trim();
  if (!text || text === 'null') return { fields: [], text: null };
  try {
    return { fields: readableFields(JSON.parse(text)), text: null };
  } catch {
    return { fields: [], text: clip(text) };
  }
}
