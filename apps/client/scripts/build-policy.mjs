/**
 * Public deploys omit source maps. Watch, mock and fake-auth builds are local
 * development/test surfaces, where maps make browser failures actionable.
 */
export function shouldEmitSourceMaps({ watch, mock, authMode }) {
  return watch || mock || authMode === 'fake';
}
