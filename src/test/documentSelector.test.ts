import * as assert from "node:assert/strict"
import { describe, it } from "node:test"
import { vDocumentSelector } from "../documentSelector"

/** Whether a document of this language and scheme is served.
 *
 * An entry with no scheme matches every scheme, which is what `v.mod` relies on.
 */
function serves(language: string, scheme: string): boolean {
	return vDocumentSelector.some(
		(entry) => entry.language === language && (entry.scheme ?? scheme) === scheme,
	)
}

describe("V language server document selector", () => {
	it("serves saved V documents, unsaved V buffers and v.mod", () => {
		assert.deepStrictEqual(vDocumentSelector, [
			{ language: "v", scheme: "file" },
			{ language: "v", scheme: "untitled" },
			{ language: "v.mod" },
		])
	})

	it("serves the unsaved buffer the decoder commands generate", () => {
		assert.equal(serves("v", "untitled"), true)
	})

	it("serves a v.mod document, no matter how it is opened", () => {
		for (const scheme of ["file", "untitled", "vscode-remote"]) {
			assert.equal(serves("v.mod", scheme), true)
		}
	})

	it("does not extend the unsaved-buffer scheme to another language", () => {
		for (const language of ["json", "xml", "csv", "plaintext"]) {
			assert.equal(
				serves(language, "untitled"),
				false,
				`an untitled ${language} buffer is not the V server's to answer`,
			)
		}
	})
})
