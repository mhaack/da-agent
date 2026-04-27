/**
 * If the path has no file extension, append ".html".
 * Paths already ending in any extension (.html, .md, .json, .png, …) are left unchanged.
 */
export function ensureHtmlExtension(path: string): string {
  if (!path) return path;
  const last = path.split('/').pop() ?? '';
  return last.includes('.') ? path : `${path}.html`;
}

/** Route views where the open document is synced with da-collab (Yjs); agent may join the same session. */
const COLLAB_ELIGIBLE_VIEWS = new Set(['edit', 'canvas']);

export function isCollabEligibleView(view: string | undefined): boolean {
  return view != null && COLLAB_ELIGIBLE_VIEWS.has(view);
}
