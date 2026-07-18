// @ts-check

// Shared JSDoc typedefs for the webview modules. Carries no runtime code —
// other modules reference these via `import("./types.js").Name`.

/** @typedef {{ pattern: string; include: string; exclude: string; caseSensitive: boolean; wholeWord: boolean; useRegex: boolean; replace: string }} SearchState */
/** @typedef {{ text: string; color: string | null }} TokenSpan */
/** @typedef {{ line: number; text: string; tokens?: TokenSpan[] }} ContextLine */
/** @typedef {{ id: number; file: string; relativePath: string; line: number; column: number; lineText: string; matchStart: number; matchEnd: number; contextBefore: ContextLine[]; contextAfter: ContextLine[]; breadcrumb: string; tokens?: TokenSpan[] }} SearchMatch */
/** @typedef {{ family: string; color: string; char: string }} IconFont */
/** @typedef {{ file: string; relativePath: string; directory: string; fileName: string; matches: SearchMatch[]; iconUri?: string; iconFont?: IconFont }} FileResult */
/** @typedef {{ queryId: string; fileResults: FileResult[]; total: number; truncated: boolean; warning?: string }} SearchResults */
/** @typedef {{ contextBefore: ContextLine[]; contextAfter: ContextLine[]; canExpandBefore: boolean; canExpandAfter: boolean }} ExpandedSection */

export {}
