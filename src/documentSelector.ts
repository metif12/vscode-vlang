/** Where V language features apply.
 *
 * Pure and `vscode`-free so the selector is testable without an editor. The
 * entries are structurally compatible with `vscode.DocumentFilter`.
 */

/** A document as the selector names it. */
export interface VDocumentFilter {
	language: string
	/** Absent means every scheme, which is how the extension's other providers
	 * declare this language. */
	scheme?: string
}

/** Documents the language server serves.
 *
 * `v.mod` is a second contributed language id, and a file named `v.mod` has
 * always had the highlighting, folding and hover of the other providers while
 * getting nothing from the server.
 *
 * `untitled` is where the decoder commands put what they generate: they open
 * `{ language: "v", content }` and show it, so without the scheme the document
 * that is this extension's own output has no completion and no diagnostics. It
 * is scoped to `v`, because nothing here creates an unsaved buffer of another
 * language.
 */
export const vDocumentSelector: readonly VDocumentFilter[] = [
	{ language: "v", scheme: "file" },
	{ language: "v", scheme: "untitled" },
	{ language: "v.mod" },
]
