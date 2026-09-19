export type InputProvenance = 'sample' | 'customer' | 'unknown';

export function inputProvenanceLabel(value: InputProvenance): string {
  if (value === 'sample') return 'Sample data';
  if (value === 'customer') return 'Customer data';
  return 'Input source not recorded';
}

export function InputProvenanceBadge({ value }: { value: InputProvenance }) {
  return <span className={`pill partner-provenance-badge${value === 'sample' ? ' illustrative' : value === 'unknown' ? ' pill-warn' : ''}`}>{inputProvenanceLabel(value)}</span>;
}
