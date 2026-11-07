/** Display names only: persisted integration and audit identifiers remain stable. */
export function applicationDisplayName(source: string): string {
  return ['holy-sheet', 'holy-sheet-import', 'holy-sheet-template', 'holy-sheet-intake'].includes(source)
    ? 'Pages by Aplyd'
    : source;
}
