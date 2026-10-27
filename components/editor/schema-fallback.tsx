'use client';
import type { RichNode } from '../../lib/document';

// Do not parse unfamiliar data with the editor's schema or assume its child shape.
export function documentPreviewText(document: unknown): string {
  const stack: unknown[] = [document], text: string[] = [];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    const value = node as { text?: unknown; content?: unknown };
    if (typeof value.text === 'string') text.push(value.text);
    if (Array.isArray(value.content)) for (let i = value.content.length - 1; i >= 0; i--) stack.push(value.content[i]);
  }
  return text.join('\n');
}

export default function SchemaFallback({ title, document, schemaVersion }: { title: string; document: RichNode; schemaVersion: number }) {
  function download() {
    const blob = new Blob([JSON.stringify({ title, schemaVersion, document }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = window.document.createElement('a');
    link.href = url; link.download = 'holy-sheet-document.json';
    try { link.click(); } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  return <section aria-label="Read-only document preview">
    <p className="document-warning" role="status">This page uses a different document version. This preview is read-only; open it in a compatible Holy Sheet version to edit. Some formatting or blocks may not appear here. The complete document data is preserved.</p>
    <button onClick={download}>Download document data</button>
    <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'inherit' }}>{documentPreviewText(document) || 'No text preview is available for these blocks.'}</pre>
  </section>;
}
