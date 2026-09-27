import type { ReadableField } from './fields.js';
import './field-list.css';

/** Labelled values, one per row. Never JSON (docs/DESIGN.md). */
export function FieldList({ fields, empty, label }: { fields: readonly ReadableField[]; empty: string; label?: string }) {
  if (fields.length === 0) return <p className="meta">{empty}</p>;
  return (
    <dl className="field-list" aria-label={label}>
      {fields.map((field, index) => (
        <div key={`${field.label}-${index}`}>
          <dt>{field.label}</dt>
          <dd>{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}
