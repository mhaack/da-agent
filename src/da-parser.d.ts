/**
 * Type declarations for @da-tools/da-parser (EDS HTML ↔ Y.Doc).
 */
declare module '@da-tools/da-parser' {
  export function aem2doc(html: string, ydoc: import('yjs').Doc): void;
  export function doc2aem(ydoc: import('yjs').Doc): string;
}
