/** Pure VML logic: parse a ui2 `.vml` document and resolve applied styles.
 *
 * Kept vscode-free so it is testable without an editor. The editor wiring
 * (hover provider) lives in `commands.ts` next to the other providers.
 *
 * The model mirrors what ui2 itself does: nested blocks with parent-local
 * frames. A `Style` block holds rules for its owning node's subtree;
 * `Kind` / `Kind.class` selectors match descendants, pseudo-classes such as
 * `:hover` only apply while that state holds (so static resolution reports
 * them separately instead of merging them in), and inline props win over
 * sheet rules.
 */

export interface VmlNode {
	kind: string
	props: Record<string, string>
	children: VmlNode[]
	/** Zero-based document lines covering the block header through `}`. */
	startLine: number
	endLine: number
	/** Zero-based UTF-16 columns of the header start and the closing `}`. */
	startCol: number
	endCol: number
}

export interface VmlSelectorPart {
	kind: string
	/** Without the leading `#` (`login` for `Button#login`). */
	id: string
	/** Dot-joined when the compound lists several classes (`primary.big`). */
	className: string
}

export interface VmlStyleRule {
	kind: string
	/** Dot-joined when the selector lists several classes (`primary.big`). */
	className: string
	/** Without the leading `#` (`login` for `Button#login`), or "" when absent. */
	id: string
	/** Pseudo-class without the colon (`hover`), or "" when unconditional. */
	pseudo: string
	/**
	 * Functional pseudo-class argument (`2` for `:nth-child(2)`), or ""
	 * for plain pseudo-classes and unconditional rules.
	 */
	pseudoArg: string
	/** Full selector header as written (`Screen Button#login.primary`), for hover. */
	selector: string
	/** Ancestor compounds for descendant selectors, outermost first. */
	ancestors: VmlSelectorPart[]
	/**
	 * Combinator joining each ancestor to what follows it toward the
	 * target (`">"` for a child step, `" "` for a descendant step).
	 * Length always matches `ancestors`: entry `i` connects
	 * `ancestors[i]` to the next selector part (`combinators[last]`
	 * connects the innermost ancestor to the target itself).
	 */
	combinators: string[]
	/**
	 * Wrapping `@media`/`@container` header (`@media (max-width: 600px)`),
	 * or "" for unconditional rules. Conditional rules never match
	 * statically; the hover lists them separately.
	 */
	condition: string
	declarations: Record<string, string>
	/** Zero-based line of the rule header, for hover ranges. */
	line: number
}

/**
 * Strip line, VSS block and HTML comments, leaving anything inside
 * quotes (e.g. URLs) alone. Removed characters are blanked with spaces —
 * newlines included — so offsets, lines and columns in the cleaned text
 * still match the original document.
 */
function stripComments(text: string): string {
	let out = ""
	let quote = ""
	let escaped = false
	let parenDepth = 0
	for (let index = 0; index < text.length; index++) {
		const char = text[index] ?? ""
		if (quote) {
			out += char
			if (escaped) {
				escaped = false
			} else if (char === "\\") {
				escaped = true
			} else if (char === quote) {
				quote = ""
			}
			continue
		}
		if (char === '"' || char === "'") {
			quote = char
			out += char
			continue
		}
		if (char === "(") {
			parenDepth++
			out += char
			continue
		}
		if (char === ")" && parenDepth > 0) {
			parenDepth--
			out += char
			continue
		}
		// A `//` inside `url(...)` (e.g. `http://…`) is part of the value,
		// not a VML line comment.
		if (parenDepth === 0 && char === "/" && text[index + 1] === "/") {
			while (index < text.length && text[index] !== "\n") {
				out += " "
				index++
			}
			// Keep the newline so later line numbers still line up.
			if (index < text.length) {
				out += "\n"
			}
			continue
		}
		if (char === "/" && text[index + 1] === "*") {
			const end = text.indexOf("*/", index + 2)
			const stop = end === -1 ? text.length : end + 2
			for (; index < stop; index++) {
				out += text[index] === "\n" ? "\n" : " "
			}
			// The loop's increment lands on `stop`.
			index--
			continue
		}
		if (text.startsWith("<!--", index)) {
			const end = text.indexOf("-->", index + 4)
			const stop = end === -1 ? text.length : end + 3
			for (; index < stop; index++) {
				out += text[index] === "\n" ? "\n" : " "
			}
			// The loop's increment lands on `stop`.
			index--
			continue
		}
		out += char
	}
	return out
}

/** Zero-based line and UTF-16 column of an index into the document. */
function positionOf(text: string, index: number): { line: number; col: number } {
	let line = 0
	let col = 0
	for (let i = 0; i < index && i < text.length; i++) {
		if (text[i] === "\n") {
			line++
			col = 0
		} else {
			col++
		}
	}
	return { line, col }
}

function lineOf(text: string, index: number): number {
	return positionOf(text, index).line
}

/** Find the `}` closing the brace at `openIndex`, ignoring braces in strings. */
function findMatchingBrace(text: string, openIndex: number): number {
	let depth = 0
	let parenDepth = 0
	let quote = ""
	let escaped = false
	for (let index = openIndex; index < text.length; index++) {
		const char = text[index] ?? ""
		if (quote) {
			if (escaped) {
				escaped = false
			} else if (char === "\\") {
				escaped = true
			} else if (char === quote) {
				quote = ""
			}
			continue
		}
		if (char === '"' || char === "'") {
			quote = char
			continue
		}
		if (char === "(") {
			parenDepth++
			continue
		}
		if (char === ")" && parenDepth > 0) {
			parenDepth--
			continue
		}
		// A `//` inside `url(...)` (e.g. `http://…`) is part of the value,
		// not a comment, so it must not swallow the rest of the line here
		// either — otherwise a brace later on the line would be missed.
		if (parenDepth === 0 && char === "/" && text[index + 1] === "/") {
			while (index < text.length && text[index] !== "\n") {
				index++
			}
			continue
		}
		if (char === "/" && text[index + 1] === "*") {
			const end = text.indexOf("*/", index + 2)
			index = end === -1 ? text.length : end + 1
			continue
		}
		if (text.startsWith("<!--", index)) {
			const end = text.indexOf("-->", index + 4)
			index = end === -1 ? text.length : end + 2
			continue
		}
		if (char === "{") {
			depth++
		} else if (char === "}") {
			depth--
			if (depth === 0) {
				return index
			}
		}
	}
	return -1
}

const propKeyPattern = /^(@?[A-Za-z_][A-Za-z0-9_.-]*)\s*:/

/**
 * Split one line into generic `key: value` segments. Any key matches (no
 * whitelist), so compact rows like `id: heading x: 48 width: 100` all parse.
 * A `key:` only starts a segment outside quotes and right after the line
 * start, whitespace or `;`, so `https://…` values and `a: b` prose inside
 * quotes stay intact. Trailing `;` separators are stripped.
 */
function parsePropSegments(line: string): Array<[string, string]> {
	const starts: Array<{ key: string; keyStart: number; valueStart: number }> = []
	let quote = ""
	let escaped = false
	for (let index = 0; index < line.length; index++) {
		const char = line[index] ?? ""
		if (quote) {
			if (escaped) {
				escaped = false
			} else if (char === "\\") {
				escaped = true
			} else if (char === quote) {
				quote = ""
			}
			continue
		}
		if (char === '"' || char === "'") {
			quote = char
			continue
		}
		if (index > 0) {
			const prev = line[index - 1] ?? ""
			if (prev !== ";" && !/\s/.test(prev)) {
				continue
			}
		}
		const match = line.slice(index).match(propKeyPattern)
		if (match?.[1]) {
			starts.push({ key: match[1], keyStart: index, valueStart: index + match[0].length })
		}
	}
	return starts.map(
		(start, position) =>
			[
				start.key,
				line
					.slice(start.valueStart, starts[position + 1]?.keyStart ?? line.length)
					.trim()
					.replace(/;+$/, "")
					.trim(),
			] as [string, string],
	)
}

/** Split on a separator, ignoring separators inside quoted strings. */
function splitOutsideQuotes(text: string, separator: string): string[] {
	const parts: string[] = []
	let current = ""
	let quote = ""
	let escaped = false
	for (const char of text) {
		if (quote) {
			current += char
			if (escaped) {
				escaped = false
			} else if (char === "\\") {
				escaped = true
			} else if (char === quote) {
				quote = ""
			}
			continue
		}
		if (char === '"' || char === "'") {
			quote = char
			current += char
			continue
		}
		if (char === separator) {
			parts.push(current)
			current = ""
			continue
		}
		current += char
	}
	parts.push(current)
	return parts
}

/** Parse one compound such as `Button#login.primary`, `.card`, `#login` or `*`. */
function parseCompound(part: string): VmlSelectorPart | undefined {
	if (part === "*") {
		return { kind: "*", id: "", className: "" }
	}
	const kindMatch = part.match(/^([A-Za-z_][A-Za-z0-9_]*)/)
	const kind = kindMatch?.[1] ?? ""
	let rest = kind ? part.slice(kind.length) : part
	let id = ""
	const classes: string[] = []
	while (rest.length > 0) {
		if (rest.startsWith("#")) {
			if (id) {
				return undefined
			}
			const idMatch = rest.match(/^#([A-Za-z_][A-Za-z0-9_-]*)/)
			if (!idMatch?.[1]) {
				return undefined
			}
			id = idMatch[1]
			rest = rest.slice(idMatch[0].length)
		} else if (rest.startsWith(".")) {
			const classMatch = rest.match(/^\.([A-Za-z_][A-Za-z0-9_-]*)/)
			if (!classMatch?.[1]) {
				return undefined
			}
			classes.push(classMatch[1])
			rest = rest.slice(classMatch[0].length)
		} else {
			return undefined
		}
	}
	if (!kind && !id && classes.length === 0) {
		return undefined
	}
	return { kind, id, className: classes.join(".") }
}

/** Split a `A, B` selector group on commas outside quotes and parens. */
function splitSelectorGroups(header: string): string[] {
	const groups: string[] = []
	let current = ""
	let quote = ""
	let escaped = false
	let parenDepth = 0
	for (const char of header) {
		if (quote) {
			current += char
			if (escaped) {
				escaped = false
			} else if (char === "\\") {
				escaped = true
			} else if (char === quote) {
				quote = ""
			}
			continue
		}
		if (char === '"' || char === "'") {
			quote = char
			current += char
			continue
		}
		if (char === "(") {
			parenDepth++
			current += char
			continue
		}
		if (char === ")" && parenDepth > 0) {
			parenDepth--
			current += char
			continue
		}
		if (char === "," && parenDepth === 0) {
			groups.push(current)
			current = ""
			continue
		}
		current += char
	}
	groups.push(current)
	return groups.map((group) => group.trim()).filter((group) => group.length > 0)
}

function parseSelectorHeader(header: string):
	| {
			kind: string
			id: string
			className: string
			pseudo: string
			pseudoArg: string
			ancestors: VmlSelectorPart[]
			combinators: string[]
			selector: string
	  }
	| undefined {
	const trimmed = header
		.trim()
		.replace(/\s+/g, " ")
		.replace(/\s*>\s*/g, " > ")
	if (!trimmed || /["'${}]/.test(trimmed)) {
		return undefined
	}
	let withoutPseudo = trimmed
	let pseudo = ""
	let pseudoArg = ""
	// A `key: value` prop has a space after the colon; a pseudo never does,
	// and the base must still look like selector compounds.
	const isPseudoBase = (base: string): boolean =>
		base.length > 0 && !base.endsWith(":") && !/\s:\s/.test(trimmed)
	const functionalMatch = trimmed.match(/^(.*):([A-Za-z_-]+)\(([^()]*)\)\s*$/)
	if (functionalMatch?.[1] !== undefined && functionalMatch?.[2]) {
		const base = (functionalMatch[1] ?? "").trim()
		if (isPseudoBase(base)) {
			withoutPseudo = base
			pseudo = functionalMatch[2]
			pseudoArg = (functionalMatch[3] ?? "").trim()
		}
	} else {
		const pseudoMatch = trimmed.match(/^(.*):([A-Za-z_-]+)\s*$/)
		if (pseudoMatch?.[1] !== undefined && pseudoMatch?.[2]) {
			const base = (pseudoMatch[1] ?? "").trim()
			if (isPseudoBase(base)) {
				withoutPseudo = base
				pseudo = pseudoMatch[2]
			}
		}
	}
	const tokens = withoutPseudo.split(/\s+/).filter((token) => token.length > 0)
	if (tokens.length === 0) {
		return undefined
	}
	// `>` joins compounds; each compound remembers the combinator before
	// it so matching can require immediate adjacency for child steps.
	const parts: VmlSelectorPart[] = []
	const before: string[] = []
	let pending = " "
	for (const token of tokens) {
		if (token === ">") {
			if (pending === ">") {
				return undefined
			}
			pending = ">"
			continue
		}
		const parsed = parseCompound(token)
		if (!parsed) {
			return undefined
		}
		parts.push(parsed)
		before.push(pending)
		pending = " "
	}
	// A trailing `>` has nothing to join, and a leading `>` has no parent.
	if (pending === ">" || before[0] !== " ") {
		return undefined
	}
	if (parts.length === 0) {
		return undefined
	}
	const last = parts[parts.length - 1]
	if (!last) {
		return undefined
	}
	return {
		kind: last.kind,
		id: last.id,
		className: last.className,
		pseudo,
		pseudoArg,
		ancestors: parts.slice(0, -1),
		combinators: before.slice(1),
		selector: trimmed,
	}
}

function parseSelector(header: string): [string, string, string] {
	const parsed = parseSelectorHeader(header)
	if (!parsed) {
		const colon = header.indexOf(":")
		const pseudo = colon === -1 ? "" : ((header.slice(colon + 1) ?? "").trim() ?? "")
		const base = (colon === -1 ? header : header.slice(0, colon)).trim()
		const dot = base.indexOf(".")
		if (dot === -1) {
			return [base, "", pseudo]
		}
		return [base.slice(0, dot).trim(), base.slice(dot + 1).trim(), pseudo]
	}
	return [parsed.kind, parsed.className, parsed.pseudo]
}

/** A header names a style selector when it carries a class, id, pseudo or ancestor. */
function isSelectorHeader(header: string): boolean {
	const groups = splitSelectorGroups(header)
	if (groups.length > 1) {
		// A `Button, Label` group header is a rule when every group parses.
		return groups.every((group) => parseSelectorHeader(group) !== undefined)
	}
	const parsed = parseSelectorHeader(header)
	if (!parsed) {
		return header.includes(".") || header.includes(":")
	}
	if (parsed.ancestors.length > 0) {
		return true
	}
	if (parsed.id || parsed.className || parsed.pseudo) {
		return true
	}
	return parsed.kind === "*"
}

/**
 * True when a `{ … }` body holds a nested block rather than flat
 * declarations. Scanned quote-aware so `{` inside strings (including
 * `${…}` interpolation) does not count.
 */
function containsNestedBlock(body: string): boolean {
	let quote = ""
	let escaped = false
	for (let index = 0; index < body.length; index++) {
		const char = body[index] ?? ""
		if (quote) {
			if (escaped) {
				escaped = false
			} else if (char === "\\") {
				escaped = true
			} else if (char === quote) {
				quote = ""
			}
			continue
		}
		if (char === '"' || char === "'") {
			quote = char
			continue
		}
		if (char !== "{") {
			continue
		}
		if (/(?:^|[\s;}:])\s*[A-Za-z_][A-Za-z0-9_.:#]*\s*$/.test(body.slice(0, index))) {
			return true
		}
	}
	return false
}

/**
 * Decide child node versus style rule outside `Style` mode. A body holding
 * a nested block is always a component (this covers `Column`, imported
 * widgets, and lowercase custom tags); otherwise only a selector-shaped
 * header (`Kind.class`, `Kind#id`, `.class`, `Kind:pseudo`, descendants)
 * over flat declarations is a rule — any other header, upper- or lowercase,
 * names a component node.
 */
function isComponentBlock(header: string, inner: string): boolean {
	if (containsNestedBlock(inner)) {
		return true
	}
	return !isSelectorHeader(header)
}

/** Parse flat `key: value` declarations (no nested blocks) into a map. */
function parseDeclarations(text: string): Record<string, string> {
	const declarations: Record<string, string> = {}
	for (const chunk of splitOutsideQuotes(text, ";")) {
		for (const line of chunk.split("\n")) {
			const trimmed = line.trim()
			if (!trimmed) {
				continue
			}
			for (const [key, value] of parsePropSegments(trimmed)) {
				if (value !== "") {
					declarations[key] = value
				}
			}
		}
	}
	return declarations
}

interface NestedRuleBlock {
	header: string
	body: string
	/** Absolute document offset of the nested header start. */
	offset: number
	/** Absolute document offset of the first character inside the nested `{ … }`. */
	bodyOffset: number
}

interface SplitRuleBody {
	declarations: string
	nested: NestedRuleBlock[]
}

/**
 * Split a style-rule body into flat declaration text and nested rule
 * blocks. Quote-aware so `{` inside strings (including `${…}`
 * interpolation) never starts a block. `innerOffset` is the absolute
 * document offset of `inner[0]`, used for nested rule line numbers.
 */
function splitRuleBody(inner: string, innerOffset: number): SplitRuleBody {
	let declarations = ""
	const nested: NestedRuleBlock[] = []
	let quote = ""
	let escaped = false
	let parenDepth = 0
	let segStart = 0
	let headerStart = 0
	let index = 0
	while (index < inner.length) {
		const char = inner[index] ?? ""
		if (quote) {
			if (escaped) {
				escaped = false
			} else if (char === "\\") {
				escaped = true
			} else if (char === quote) {
				quote = ""
			}
			index++
			continue
		}
		if (char === '"' || char === "'") {
			quote = char
			index++
			continue
		}
		if (char === "(") {
			parenDepth++
			index++
			continue
		}
		if (char === ")" && parenDepth > 0) {
			parenDepth--
			index++
			continue
		}
		// A `;` outside values ends the declarations before a nested header,
		// so `color: red; Label { … }` yields header `Label`, not the
		// declaration text with it.
		if (char === ";" && parenDepth === 0) {
			headerStart = index + 1
			index++
			continue
		}
		if (char !== "{") {
			index++
			continue
		}
		const braceClose = findMatchingBrace(inner, index)
		if (braceClose === -1) {
			break
		}
		let headerOffset = headerStart
		while (headerOffset < index && /\s/.test(inner[headerOffset] ?? "")) {
			headerOffset++
		}
		nested.push({
			header: inner.slice(headerStart, index).trim(),
			body: inner.slice(index + 1, braceClose),
			offset: innerOffset + headerOffset,
			bodyOffset: innerOffset + index + 1,
		})
		declarations += inner.slice(segStart, headerStart)
		index = braceClose + 1
		segStart = index
		headerStart = index
	}
	declarations += inner.slice(segStart)
	return { declarations, nested }
}

/** An `@media`/`@container` wrapper header, normalized, or undefined. */
function atRuleCondition(header: string): string | undefined {
	const match = header.trim().match(/^@(media|container)\b([\s\S]*)$/i)
	if (!match) {
		return undefined
	}
	return `@${match[1]?.toLowerCase()}${match[2] ?? ""}`.trim().replace(/\s+/g, " ")
}

/**
 * Parse one `Kind[#id][.class][:pseudo]` (or descendant/group) rule body.
 * Nested blocks flatten into descendant selectors (`View.card` holding
 * `Label.title { … }` yields `View.card Label.title`), recursively, while
 * the parent keeps its own flat declarations. One rule per comma group;
 * rules without declarations are dropped.
 */
function parseRule(
	full: string,
	header: string,
	inner: string,
	offset: number,
	innerOffset: number,
): VmlStyleRule[] {
	const groups = splitSelectorGroups(header)
		.map((group) => ({ text: group, parsed: parseSelectorHeader(group) }))
		.filter((group) => group.parsed !== undefined)
	if (groups.length === 0) {
		return []
	}
	const split = splitRuleBody(inner, innerOffset)
	let declarationText = split.declarations
	const nested = split.nested.filter((block) => {
		if (atRuleCondition(block.header) !== undefined) {
			return true
		}
		// A nested `> Button` header only parses joined to its parent, so
		// validate the joined form; the recursion below drops combos that
		// still fail for a particular parent group.
		const joins = splitSelectorGroups(block.header).some(
			(childGroup) =>
				childGroup.length > 0 &&
				groups.some(
					(group) =>
						group.parsed !== undefined &&
						parseSelectorHeader(`${group.parsed.selector} ${childGroup}`) !== undefined,
				),
		)
		if (joins) {
			return true
		}
		// Not a nested rule (e.g. an unquoted `${…}` value holding braces):
		// keep it verbatim so its text still parses as declarations.
		declarationText += ` ${block.header} {${block.body}} `
		return false
	})
	const declarations = parseDeclarations(declarationText)
	const rules: VmlStyleRule[] = []
	for (const group of groups) {
		const parsed = group.parsed
		if (!parsed) {
			continue
		}
		if (Object.keys(declarations).length > 0) {
			rules.push({
				kind: parsed.kind,
				className: parsed.className,
				id: parsed.id,
				pseudo: parsed.pseudo,
				pseudoArg: parsed.pseudoArg,
				selector: parsed.selector,
				ancestors: parsed.ancestors,
				combinators: parsed.combinators,
				condition: "",
				declarations: { ...declarations },
				line: lineOf(full, offset),
			})
		}
		for (const block of nested) {
			const condition = atRuleCondition(block.header)
			if (condition !== undefined) {
				for (const innerRule of parseAtInner(full, block.body, block.offset, condition)) {
					rules.push(prefixRule(innerRule, parsed))
				}
				continue
			}
			for (const childGroup of splitSelectorGroups(block.header)) {
				rules.push(
					...parseRule(
						full,
						`${parsed.selector} ${childGroup}`,
						block.body,
						block.offset,
						block.bodyOffset,
					),
				)
			}
		}
	}
	return rules
}

/**
 * Parse an `@media`/`@container` body as style rules and tag each with
 * the wrapper condition (combined with any inner condition).
 */
function parseAtInner(
	full: string,
	body: string,
	bodyOffset: number,
	condition: string,
): VmlStyleRule[] {
	const parsed = parseBody(full, body, bodyOffset, true)
	return parsed.rules.map((rule) => ({
		...rule,
		condition: rule.condition ? `${condition} and ${rule.condition}` : condition,
	}))
}

/**
 * Prefix an already-parsed rule with a parent selector (for nested
 * `@media` bodies): `View.card` + `Label` becomes `View.card Label`,
 * keeping the inner rule's own combinators after a descendant step.
 */
function prefixRule(
	rule: VmlStyleRule,
	parent: NonNullable<ReturnType<typeof parseSelectorHeader>>,
): VmlStyleRule {
	const parentTarget: VmlSelectorPart = {
		kind: parent.kind,
		id: parent.id,
		className: parent.className,
	}
	return {
		...rule,
		ancestors: [
			...parent.ancestors.map((ancestor) => ({ ...ancestor })),
			parentTarget,
			...rule.ancestors.map((ancestor) => ({ ...ancestor })),
		],
		combinators: [...parent.combinators, " ", ...rule.combinators],
		selector: `${parent.selector} ${rule.selector}`,
	}
}

/** Parse one block body into props, style rules and child blocks. */
function parseBody(
	full: string,
	body: string,
	bodyOffset: number,
	styleMode = false,
): { props: Record<string, string>; rules: VmlStyleRule[]; children: VmlNode[] } {
	const props: Record<string, string> = {}
	const rules: VmlStyleRule[] = []
	const children: VmlNode[] = []
	let index = 0
	while (index < body.length) {
		while (index < body.length && /\s/.test(body[index] ?? "")) {
			index++
		}
		if (index >= body.length) {
			break
		}
		const rest = body.slice(index)
		const blockMatch = rest.match(/^([@A-Za-z_.*#,][A-Za-z0-9_.#:*\s>,@()\-]*?)\s*\{/)
		const header = (blockMatch?.[1] ?? "").trim()
		// `@media`/`@container` headers hold `: ` (e.g. `max-width: 600px`)
		// but are at-rules, never props.
		if (blockMatch && (atRuleCondition(header) !== undefined || !/:\s/.test(header))) {
			const braceOpen = index + (blockMatch[0].length - 1)
			const braceClose = findMatchingBrace(body, braceOpen)
			if (braceClose === -1) {
				break
			}
			const inner = body.slice(braceOpen + 1, braceClose)
			const condition = atRuleCondition(header)
			if (condition !== undefined) {
				rules.push(...parseAtInner(full, inner, bodyOffset + braceOpen + 1, condition))
			} else if (!styleMode && isComponentBlock(header, inner)) {
				const child = parseBlock(full, header, inner, bodyOffset + index)
				if (child) {
					children.push(child)
				}
			} else {
				// A `Kind.class` / `Kind:pseudo` style rule (or anything inside `Style`).
				rules.push(
					...parseRule(
						full,
						header,
						inner,
						bodyOffset + index,
						bodyOffset + braceOpen + 1,
					),
				)
			}
			index = braceClose + 1
			continue
		}
		// Consume one line of props. Line-based so the index always advances:
		// a trailing block-header fragment (e.g. `Style` before its `{`)
		// is skipped here and parsed as a block on the next iteration.
		const newline = body.indexOf("\n", index)
		const lineEnd = newline === -1 ? body.length : newline
		const line = body.slice(index, lineEnd).trim()
		if (line) {
			for (const [key, value] of parsePropSegments(line)) {
				if (value !== "") {
					props[key] = value
				}
			}
		}
		index = newline === -1 ? body.length : newline + 1
	}
	return { props, rules, children }
}

function appendEmbeddedRules(node: VmlNode, rules: VmlStyleRule[]): void {
	if (rules.length === 0) {
		return
	}
	let existing: VmlStyleRule[] = []
	if (node.props.__rules) {
		try {
			existing = normalizeRules(JSON.parse(node.props.__rules) as VmlStyleRule[])
		} catch {
			existing = []
		}
	}
	node.props.__rules = JSON.stringify([...existing, ...rules])
}

/** `@var` definitions held directly in a props map (values unquoted). */
function varsFromProps(props: Record<string, string>): Record<string, string> {
	const vars: Record<string, string> = {}
	for (const [key, value] of Object.entries(props)) {
		if (key.startsWith("@") && key.length > 1) {
			vars[key] = unquote(value)
		}
	}
	return vars
}

function appendEmbeddedVars(node: VmlNode, vars: Record<string, string>): void {
	const keys = Object.keys(vars)
	if (keys.length === 0) {
		return
	}
	let existing: Record<string, string> = {}
	if (node.props.__vars) {
		try {
			existing = JSON.parse(node.props.__vars) as Record<string, string>
		} catch {
			existing = {}
		}
	}
	node.props.__vars = JSON.stringify({ ...existing, ...vars })
}

/** Backfill rules read from `__rules` JSON that predate newer fields. */
function normalizeRules(rules: VmlStyleRule[]): VmlStyleRule[] {
	return rules.map((rule) => {
		const ancestors = Array.isArray(rule.ancestors) ? rule.ancestors : []
		const combinators =
			Array.isArray(rule.combinators) && rule.combinators.length === ancestors.length
				? rule.combinators.map((entry) => (entry === ">" ? ">" : " "))
				: ancestors.map(() => " ")
		if (
			typeof rule.id === "string" &&
			typeof rule.selector === "string" &&
			typeof rule.pseudoArg === "string" &&
			typeof rule.condition === "string" &&
			Array.isArray(rule.ancestors) &&
			Array.isArray(rule.combinators) &&
			rule.combinators.length === ancestors.length
		) {
			return {
				...rule,
				combinators,
			}
		}
		const header =
			`${rule.kind ?? ""}${typeof rule.id === "string" && rule.id ? `#${rule.id}` : ""}${rule.className ? `.${rule.className}` : ""}${rule.pseudo ? `:${rule.pseudo}` : ""}` ||
			"*"
		const parsed = parseSelectorHeader(header)
		// Prefer stored ancestors (they already encode descendant steps);
		// fall back to the rebuilt header only when none were stored.
		const finalAncestors = ancestors.length > 0 ? ancestors : (parsed?.ancestors ?? [])
		const finalCombinators =
			ancestors.length > 0 ? combinators : parsed ? parsed.combinators : combinators
		return {
			kind: rule.kind ?? "",
			className: rule.className ?? "",
			id: typeof rule.id === "string" ? rule.id : "",
			pseudo: rule.pseudo ?? "",
			pseudoArg: typeof rule.pseudoArg === "string" ? rule.pseudoArg : "",
			selector: typeof rule.selector === "string" ? rule.selector : header,
			ancestors: finalAncestors,
			combinators: finalCombinators,
			condition: typeof rule.condition === "string" ? rule.condition : "",
			declarations: rule.declarations ?? {},
			line: rule.line ?? 0,
		}
	})
}

function parseBlock(
	full: string,
	header: string,
	body: string,
	offset: number,
): VmlNode | undefined {
	const lastToken =
		header
			.trim()
			.split(/\s*>\s*|\s+/)
			.pop() ?? ""
	const kind = lastToken.split(/[.:#]/)[0]?.trim() ?? ""
	if (!kind || kind === "*") {
		return undefined
	}
	const braceOpen = full.indexOf("{", offset)
	const braceClose = findMatchingBrace(full, braceOpen)
	const parsed = parseBody(full, body, braceOpen + 1, kind === "Style")
	const props = { ...parsed.props }
	if (!props["class"]) {
		const [, className] = parseSelector(header)
		if (className) {
			props["class"] = className
		}
	}
	const start = positionOf(full, offset)
	const end =
		braceClose === -1 ? { line: start.line, col: start.col } : positionOf(full, braceClose)
	const node: VmlNode = {
		kind,
		props,
		children: parsed.children.filter((child) => child.kind !== "Style"),
		startLine: start.line,
		startCol: start.col,
		endLine: end.line,
		endCol: end.col,
	}
	const embedded: VmlStyleRule[] = [...parsed.rules]
	const embeddedVars: Record<string, string> = varsFromProps(parsed.props)
	for (const child of parsed.children) {
		if (child.kind === "Style") {
			if (child.props.__rules) {
				try {
					embedded.push(
						...normalizeRules(JSON.parse(child.props.__rules) as VmlStyleRule[]),
					)
				} catch {
					// Malformed embedded rules never break the hover.
				}
			}
			if (child.props.__vars) {
				try {
					Object.assign(
						embeddedVars,
						JSON.parse(child.props.__vars) as Record<string, string>,
					)
				} catch {
					// Malformed embedded variables never break the hover.
				}
			}
			// A `Style` child's own `@var` props (kept alongside `__vars`).
			Object.assign(embeddedVars, varsFromProps(child.props))
		}
	}
	if (embedded.length > 0) {
		node.props.__rules = JSON.stringify(embedded)
	}
	if (Object.keys(embeddedVars).length > 0) {
		node.props.__vars = JSON.stringify(embeddedVars)
	}
	return node
}

/** Parse a whole `.vml` document into top-level blocks. */
export function parseVml(text: string): VmlNode[] {
	const clean = stripComments(text)
	const nodes: VmlNode[] = []
	const globals: VmlStyleRule[] = []
	const globalVars: Record<string, string> = {}
	let index = 0
	while (index < clean.length) {
		while (index < clean.length && /\s/.test(clean[index] ?? "")) {
			index++
		}
		if (index >= clean.length) {
			break
		}
		const rest = clean.slice(index)
		const blockMatch = rest.match(/^([@A-Za-z_.*#,][A-Za-z0-9_.#:*\s>,@()\-]*?)\s*\{/)
		const header = (blockMatch?.[1] ?? "").trim()
		const topCondition = blockMatch ? atRuleCondition(header) : undefined
		if (!blockMatch || (topCondition === undefined && /:\s/.test(header))) {
			// A top-level `@var: value;` definition (no owning block).
			const varMatch = rest.match(/^(@[A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*([^\n;{}]+);?/)
			if (varMatch?.[1] && varMatch?.[2] !== undefined) {
				globalVars[varMatch[1]] = unquote(varMatch[2] ?? "")
				index += varMatch[0].length
				continue
			}
			index++
			continue
		}
		const braceOpen = index + (blockMatch[0].length - 1)
		const braceClose = findMatchingBrace(clean, braceOpen)
		if (braceClose === -1) {
			break
		}
		const inner = clean.slice(braceOpen + 1, braceClose)
		const condition = atRuleCondition(header)
		if (condition !== undefined) {
			globals.push(...parseAtInner(clean, inner, braceOpen + 1, condition))
		} else if (isSelectorHeader(header)) {
			// A stray top-level rule with no owning node: keep it global.
			// Nested blocks flatten into descendant selectors here too.
			globals.push(...parseRule(clean, header, inner, index, braceOpen + 1))
		} else {
			const node = parseBlock(clean, header, inner, index)
			if (node) {
				nodes.push(node)
			}
		}
		index = braceClose + 1
	}
	if (globals.length > 0) {
		for (const node of nodes) {
			appendEmbeddedRules(node, globals)
		}
	}
	if (Object.keys(globalVars).length > 0) {
		for (const node of nodes) {
			appendEmbeddedVars(node, globalVars)
		}
	}
	return nodes
}

/**
 * Style rules in scope for a tree. Without `target` this collects every rule
 * (kept for back-compat); hover callers must pass the hovered block so rules
 * from unrelated subtrees never leak in — only the target's ancestor chain
 * plus its own rules are returned.
 */
export function collectRules(nodes: VmlNode[], target?: VmlNode): VmlStyleRule[] {
	const ownRules = (node: VmlNode): VmlStyleRule[] => {
		if (!node.props.__rules) return []
		try {
			return normalizeRules(JSON.parse(node.props.__rules) as VmlStyleRule[])
		} catch {
			return []
		}
	}
	if (target) {
		const findPath = (node: VmlNode, inherited: VmlStyleRule[]): VmlStyleRule[] | undefined => {
			const scoped = [...inherited, ...ownRules(node)]
			if (node === target) return scoped
			for (const child of node.children) {
				const found = findPath(child, scoped)
				if (found) return found
			}
			return undefined
		}
		for (const node of nodes) {
			const found = findPath(node, [])
			if (found) return found
		}
		return []
	}
	const rules: VmlStyleRule[] = []
	const visit = (node: VmlNode): void => {
		rules.push(...ownRules(node))
		for (const child of node.children) {
			visit(child)
		}
	}
	for (const node of nodes) {
		visit(node)
	}
	return rules
}

/** Ancestor chain for a block, outermost first (empty when absent). */
export function ancestorsOf(nodes: VmlNode[], target: VmlNode): VmlNode[] {
	const findPath = (node: VmlNode, trail: VmlNode[]): VmlNode[] | undefined => {
		if (node === target) return trail
		for (const child of node.children) {
			const found = findPath(child, [...trail, node])
			if (found) return found
		}
		return undefined
	}
	for (const node of nodes) {
		const found = findPath(node, [])
		if (found) return found
	}
	return []
}

/** `@var` values in scope for a tree (ancestor chain plus own, inner wins). */
export function collectVariables(nodes: VmlNode[], target?: VmlNode): Record<string, string> {
	const ownVars = (node: VmlNode): Record<string, string> => {
		const merged = varsFromProps(node.props)
		if (node.props.__vars) {
			try {
				Object.assign(merged, JSON.parse(node.props.__vars) as Record<string, string>)
			} catch {
				// Malformed variables never break the hover.
			}
		}
		return merged
	}
	if (target) {
		const path = ancestorsOf(nodes, target)
		const merged: Record<string, string> = {}
		for (const ancestor of path) {
			Object.assign(merged, ownVars(ancestor))
		}
		Object.assign(merged, ownVars(target))
		return merged
	}
	const merged: Record<string, string> = {}
	const visit = (node: VmlNode): void => {
		Object.assign(merged, ownVars(node))
		for (const child of node.children) {
			visit(child)
		}
	}
	for (const node of nodes) {
		visit(node)
	}
	return merged
}

/** Space-separated class list of a node, without surrounding quotes. */
function nodeClasses(node: VmlNode): string[] {
	return unquote(node.props["class"] ?? "")
		.split(/\s+/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
}

/** Unquoted `id` prop of a node, or "" when absent. */
function nodeId(node: VmlNode): string {
	return unquote(node.props["id"] ?? "").trim()
}

function partMatches(part: VmlSelectorPart, kind: string, classes: string[], id: string): boolean {
	// Type selectors match case-insensitively (`button` matches `Button`);
	// ids and classes stay case-sensitive.
	if (part.kind && part.kind !== "*" && part.kind.toLowerCase() !== kind.toLowerCase()) {
		return false
	}
	if (part.id && part.id !== id) {
		return false
	}
	if (part.className) {
		const wanted = part.className
			.split(".")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0)
		if (!wanted.every((entry) => classes.includes(entry))) {
			return false
		}
	}
	return true
}

/** Kind, id and (all) classes match; pseudo-classes are checked separately. */
function selectorMatches(rule: VmlStyleRule, node: VmlNode, ancestors: VmlNode[] = []): boolean {
	if (
		!partMatches(
			{ kind: rule.kind, id: rule.id, className: rule.className },
			node.kind,
			nodeClasses(node),
			nodeId(node),
		)
	) {
		return false
	}
	if (rule.ancestors.length === 0) {
		return true
	}
	const combinators =
		rule.combinators.length === rule.ancestors.length
			? rule.combinators
			: rule.ancestors.map(() => " ")
	// Match the ancestor chain backwards from the target: a child `>`
	// combinator requires the immediately preceding element, while a space
	// matches any earlier ancestor in order.
	const chain = ancestors.map((ancestor) => ({
		kind: ancestor.kind,
		classes: nodeClasses(ancestor),
		id: nodeId(ancestor),
	}))
	let pos = chain.length - 1
	for (let step = rule.ancestors.length - 1; step >= 0; step--) {
		const wanted = rule.ancestors[step]
		if (!wanted) {
			return false
		}
		if (combinators[step] === ">") {
			if (pos < 0) {
				return false
			}
			const entry = chain[pos]
			if (!entry || !partMatches(wanted, entry.kind, entry.classes, entry.id)) {
				return false
			}
			pos--
		} else {
			let found = -1
			for (let cursor = pos; cursor >= 0; cursor--) {
				const entry = chain[cursor]
				if (entry && partMatches(wanted, entry.kind, entry.classes, entry.id)) {
					found = cursor
					break
				}
			}
			if (found === -1) {
				return false
			}
			pos = found - 1
		}
	}
	return true
}

/** Structural pseudo-classes decidable from the parsed tree. */
const structuralPseudos = new Set([
	"first-child",
	"last-child",
	"only-child",
	"nth-child",
	"nth-last-child",
	"first-of-type",
	"last-of-type",
	"only-of-type",
	"nth-of-type",
	"nth-last-of-type",
	"empty",
	"root",
])

/** True for pseudo-classes decidable from the parsed tree. */
function isStructuralPseudo(pseudo: string): boolean {
	return structuralPseudos.has(pseudo.toLowerCase())
}

/** Match a 1-based position against `:nth-*()` (`odd`, `even`, `2n+1`, `3`). */
function matchesNth(argument: string, position: number): boolean {
	const compact = argument.replace(/\s+/g, "").toLowerCase()
	if (compact === "odd") {
		return position % 2 === 1
	}
	if (compact === "even") {
		return position % 2 === 0
	}
	if (/^[+-]?\d+$/.test(compact)) {
		return position === Number.parseInt(compact, 10)
	}
	const steps = compact.match(/^([+-]?\d*)n([+-]\d+)?$/)
	if (!steps) {
		return false
	}
	const first = steps[1]
	const coefficient =
		first === "" || first === "+" ? 1 : first === "-" ? -1 : Number.parseInt(first ?? "1", 10)
	const offset = steps[2] === undefined ? 0 : Number.parseInt(steps[2] ?? "0", 10)
	if (coefficient === 0) {
		return position === offset
	}
	const distance = position - offset
	if (coefficient > 0) {
		return distance >= 0 && distance % coefficient === 0
	}
	return distance <= 0 && distance % coefficient === 0
}

/**
 * Check a structural pseudo-class against the tree. Siblings come from the
 * parent's children (identity); a top-level node defaults to index 0 of 1.
 */
function structuralPseudoMatches(rule: VmlStyleRule, node: VmlNode, ancestors: VmlNode[]): boolean {
	const pseudo = rule.pseudo.toLowerCase()
	if (pseudo === "root") {
		return ancestors.length === 0
	}
	if (pseudo === "empty") {
		return node.children.length === 0
	}
	const parent = ancestors.length > 0 ? ancestors[ancestors.length - 1] : undefined
	const siblings = parent ? parent.children.filter((child) => child.kind !== "Style") : [node]
	const index = siblings.indexOf(node)
	if (index === -1) {
		return false
	}
	const ofType = pseudo.endsWith("-of-type")
	const pool = ofType
		? siblings.filter((sibling) => sibling.kind.toLowerCase() === node.kind.toLowerCase())
		: siblings
	const position = pool.indexOf(node) + 1
	const fromEnd = pool.length - position + 1
	switch (pseudo) {
		case "first-child":
		case "first-of-type":
			return position === 1
		case "last-child":
		case "last-of-type":
			return fromEnd === 1
		case "only-child":
		case "only-of-type":
			return pool.length === 1
		case "nth-child":
		case "nth-of-type":
			return matchesNth(rule.pseudoArg, position)
		case "nth-last-child":
		case "nth-last-of-type":
			return matchesNth(rule.pseudoArg, fromEnd)
		default:
			return false
	}
}

/** Pseudo-classes decidable from the tree match when they hold; dynamic ones never match statically. */
function staticPseudoMatches(rule: VmlStyleRule, node: VmlNode, ancestors: VmlNode[]): boolean {
	if (!rule.pseudo) {
		return true
	}
	if (!isStructuralPseudo(rule.pseudo)) {
		return false
	}
	return structuralPseudoMatches(rule, node, ancestors)
}

/** IDs beat classes, classes beat kinds, regardless of source order. */
function specificity(rule: VmlStyleRule): number {
	const countClasses = (dotted: string): number =>
		dotted
			.split(".")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0).length
	let score = 0
	const parts: VmlSelectorPart[] = [
		...rule.ancestors,
		{ kind: rule.kind, id: rule.id, className: rule.className },
	]
	for (const part of parts) {
		if (part.id) {
			score += 100
		}
		score += countClasses(part.className) * 10
		if (part.kind && part.kind !== "*") {
			score += 1
		}
	}
	// A pseudo-class counts like a class.
	if (rule.pseudo) {
		score += 10
	}
	return score
}

/**
 * Rules matching a block, in cascade order: more specific selectors first,
 * source order kept within the same specificity. Conditional
 * (`@media`/`@container`) rules and dynamic pseudo-class rules never match
 * statically; structural pseudo-classes (`:first-child`, …) match when they
 * hold in the parsed tree.
 */
export function matchingRules(
	node: VmlNode,
	rules: VmlStyleRule[],
	ancestors: VmlNode[] = [],
): VmlStyleRule[] {
	return normalizeRules(rules)
		.filter(
			(rule) =>
				!rule.condition &&
				selectorMatches(rule, node, ancestors) &&
				staticPseudoMatches(rule, node, ancestors),
		)
		.sort((a, b) => specificity(a) - specificity(b))
}

const inlinePropertyAliases: Record<string, string> = {
	background: "background",
	color: "color",
	"border-radius": "border-radius",
	"border-color": "border-color",
	"border-width": "border-width",
	"font-size": "font-size",
	font_size: "font-size",
	"font-weight": "font-weight",
	font_weight: "font-weight",
	bold: "font-weight",
	font_family: "font-family",
	"font-style": "font-style",
	font_style: "font-style",
	italic: "font-style",
	corner_radius: "border-radius",
	border_color: "border-color",
	border_width: "border-width",
	opacity: "opacity",
	"text-align": "text-align",
	align: "text-align",
	text_align: "text-align",
	width: "width",
	height: "height",
	padding: "padding",
	margin: "margin",
	x: "x",
	y: "y",
}

/** Map a VML prop to its CSS name, folding `snake_case` to `kebab-case`. */
function inlineCssProperty(prop: string): string | undefined {
	const direct = inlinePropertyAliases[prop]
	if (direct !== undefined) {
		return direct
	}
	const kebab = prop.toLowerCase().replaceAll("_", "-")
	const mapped = inlinePropertyAliases[kebab]
	if (mapped !== undefined) {
		return mapped
	}
	return undefined
}

/**
 * Parse a `style: "…"` attribute: `;`-separated `key: value` declarations.
 * Known props map to their CSS names; anything else passes through
 * `snake_case`-folded so explicitly authored style is never silently dropped.
 */
function parseStyleAttribute(value: string): Record<string, string> {
	const declarations: Record<string, string> = {}
	for (const part of splitOutsideQuotes(unquote(value), ";")) {
		for (const [key, entryValue] of parsePropSegments(part.trim())) {
			if (entryValue === "") {
				continue
			}
			declarations[inlineCssProperty(key) ?? key.toLowerCase().replaceAll("_", "-")] =
				unquote(entryValue)
		}
	}
	return declarations
}

/**
 * Substitute `@var` references with scoped VSS variable values. Unknown
 * names are left alone so a typo stays visible instead of vanishing.
 * Chains (`@a` holding another `@b`) resolve iteratively with a small cap
 * so a cyclic definition terminates.
 */
function resolveValue(value: string, vars: Record<string, string>): string {
	if (!value.includes("@")) {
		return value
	}
	let result = value
	for (let pass = 0; pass < 5; pass++) {
		const next = result.replace(/@[A-Za-z_][A-Za-z0-9_-]*/g, (token) => {
			if (Object.hasOwn(vars, token)) {
				return vars[token] ?? token
			}
			const withoutAt = token.slice(1)
			if (Object.hasOwn(vars, withoutAt)) {
				return vars[withoutAt] ?? token
			}
			return token
		})
		if (next === result) {
			break
		}
		result = next
	}
	return result
}

/** Map `bold`/`italic` booleans to their CSS keywords before merging. */
function inlineCssValue(prop: string, raw: string, vars: Record<string, string>): string {
	const resolved = resolveValue(unquote(raw), vars)
	const lower = resolved.toLowerCase().trim()
	if (prop === "bold") {
		if (lower === "true") {
			return "bold"
		}
		if (lower === "false") {
			return "normal"
		}
		return resolved
	}
	if (prop === "italic") {
		if (lower === "true") {
			return "italic"
		}
		if (lower === "false") {
			return "normal"
		}
		return resolved
	}
	return resolved
}

/**
 * Merged declarations for a block: sheet rules in cascade order, then the
 * `style` attribute, then individual inline props (most specific wins).
 * `@var` definitions never appear as applied style; references to them
 * resolve to the scoped value UI2 applies.
 */
export function resolvedDeclarations(
	node: VmlNode,
	rules: VmlStyleRule[],
	ancestors: VmlNode[] = [],
	variables: Record<string, string> = {},
): Record<string, string> {
	const merged: Record<string, string> = {}
	const matched = matchingRules(node, normalizeRules(rules), ancestors)
	const vars: Record<string, string> = { ...variables }
	for (const rule of matched) {
		for (const [key, value] of Object.entries(rule.declarations)) {
			if (key.startsWith("@")) {
				vars[key] = resolveValue(unquote(value), vars)
				if (!key.startsWith("@@")) {
					vars[key.slice(1)] = vars[key] ?? ""
				}
			}
		}
	}
	for (const rule of matched) {
		for (const [key, value] of Object.entries(rule.declarations)) {
			if (key.startsWith("@")) {
				continue
			}
			merged[key] = resolveValue(value, vars)
		}
	}
	if (node.props["style"] !== undefined) {
		const style = parseStyleAttribute(node.props["style"] ?? "")
		for (const [key, value] of Object.entries(style)) {
			if (key.startsWith("@")) {
				vars[key] = resolveValue(value, vars)
				continue
			}
			merged[key] = resolveValue(value, vars)
		}
	}
	for (const [prop, raw] of Object.entries(node.props)) {
		if (prop === "__rules" || prop === "__vars" || prop === "style" || prop.startsWith("@")) {
			continue
		}
		const css = inlineCssProperty(prop)
		if (css !== undefined) {
			merged[css] = inlineCssValue(prop, raw, vars)
		}
	}
	return merged
}

function unquote(value: string): string {
	const trimmed = value.trim()
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1)
	}
	return trimmed
}

function pseudoSuffix(rule: VmlStyleRule): string {
	if (!rule.pseudo) {
		return ""
	}
	return rule.pseudoArg ? `:${rule.pseudo}(${rule.pseudoArg})` : `:${rule.pseudo}`
}

function selectorText(rule: VmlStyleRule): string {
	const suffix = pseudoSuffix(rule)
	if (rule.selector) {
		if (!suffix || rule.selector.endsWith(suffix)) {
			return rule.selector
		}
		// A stored selector may predate functional-pseudo args.
		if (rule.pseudo && rule.selector.endsWith(`:${rule.pseudo}`)) {
			return `${rule.selector}(${rule.pseudoArg})`
		}
		return `${rule.selector}${suffix}`
	}
	const kindPart = rule.kind || "*"
	const idPart = rule.id ? `#${rule.id}` : ""
	const classPart = rule.className
		? `.${rule.className
				.split(".")
				.filter((entry) => entry.length > 0)
				.join(".")}`
		: ""
	const base = `${kindPart}${idPart}${classPart}` || "*"
	return `${base}${suffix}`
}

/** Innermost block covering a zero-based document line, if any. */
export function blockAtLine(nodes: VmlNode[], line: number): VmlNode | undefined {
	let found: VmlNode | undefined
	const visit = (node: VmlNode): void => {
		if (node.kind === "Style") {
			return
		}
		if (line >= node.startLine && line <= node.endLine) {
			found = node
			for (const child of node.children) {
				visit(child)
			}
		}
	}
	for (const node of nodes) {
		visit(node)
	}
	return found
}

/**
 * Innermost block covering a zero-based (line, character) cursor position,
 * if any. Unlike `blockAtLine` this tells same-line siblings apart: only a
 * block whose column span holds the cursor matches, so hovering the first of
 * `Button { … } Label { … }` on one line returns the `Button`, not the last
 * sibling.
 */
export function blockAtPosition(
	nodes: VmlNode[],
	line: number,
	character: number,
): VmlNode | undefined {
	let found: VmlNode | undefined
	const contains = (node: VmlNode): boolean => {
		const afterStart =
			line > node.startLine || (line === node.startLine && character >= node.startCol)
		const beforeEnd = line < node.endLine || (line === node.endLine && character <= node.endCol)
		return afterStart && beforeEnd
	}
	const visit = (node: VmlNode): void => {
		if (node.kind === "Style") {
			return
		}
		if (!contains(node)) {
			return
		}
		found = node
		for (const child of node.children) {
			visit(child)
		}
	}
	for (const node of nodes) {
		visit(node)
	}
	return found
}

/** Markdown hover text for a block: identity, matched rules, resolved style. */
export function hoverTextFor(
	node: VmlNode,
	rules: VmlStyleRule[],
	ancestors: VmlNode[] = [],
	variables: Record<string, string> = {},
): string {
	const lines: string[] = []
	const id = node.props["id"] ? ` id \`${unquote(node.props["id"] ?? "")}\`` : ""
	const className = node.props["class"] ? ` class \`${unquote(node.props["class"] ?? "")}\`` : ""
	lines.push(`**${node.kind}**${id}${className}`)
	const matched = matchingRules(node, rules, ancestors)
	const normalized = normalizeRules(rules)
	// Dynamic pseudo-classes (`:hover`, …) apply only while that state holds.
	const stateDependent = normalized.filter(
		(rule) =>
			rule.pseudo &&
			!isStructuralPseudo(rule.pseudo) &&
			selectorMatches(rule, node, ancestors),
	)
	// Conditional (`@media`/`@container`) rules whose base selector matches
	// but whose query is not evaluated statically.
	const conditional = normalized.filter(
		(rule) => rule.condition && selectorMatches(rule, node, ancestors),
	)
	if (matched.length === 0 && stateDependent.length === 0 && conditional.length === 0) {
		lines.push("")
		lines.push("_No stylesheet rule matches; only inline props apply._")
	} else {
		if (matched.length > 0) {
			lines.push("")
			lines.push("Matched rules:")
			for (const rule of matched) {
				lines.push(`- \`${selectorText(rule)}\``)
			}
		}
		if (stateDependent.length > 0) {
			lines.push("")
			lines.push("State-dependent rules (not applied here):")
			for (const rule of stateDependent) {
				lines.push(`- \`${selectorText(rule)}\``)
			}
		}
		if (conditional.length > 0) {
			lines.push("")
			lines.push("Conditional rules (not applied here):")
			for (const rule of conditional) {
				lines.push(`- \`${selectorText(rule)}\` (${rule.condition})`)
			}
		}
	}
	const resolved = resolvedDeclarations(node, rules, ancestors, variables)
	const keys = Object.keys(resolved)
	if (keys.length > 0) {
		lines.push("")
		lines.push("Applied style:")
		for (const key of keys) {
			lines.push(`- ${key}: \`${resolved[key]}\``)
		}
	}
	return lines.join("\n")
}
