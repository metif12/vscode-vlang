import * as assert from "assert"
import { describe, it } from "node:test"
import {
	ancestorsOf,
	blockAtLine,
	blockAtPosition,
	collectRules,
	collectVariables,
	hoverTextFor,
	matchingRules,
	parseVml,
	resolvedDeclarations,
} from "../vml"

const counter = `Screen {
	id: root
	background: #F1F5F9
	Style {
		Button.action {
			background: #3478D4;
			color: #FFFFFF;
		}
		Label.count { color: #111827; font-size: 20px; }
	}
	Rectangle {
		id: card
		class: card
		Button {
			id: increment
			class: action
			text: "Count"
			background: #000000
		}
		Label {
			id: count
			class: count
			text: app.count
		}
	}
}
`

describe("VML style resolution", () => {
	it("parses nested blocks with line numbers", () => {
		const nodes = parseVml(counter)
		assert.strictEqual(nodes.length, 1)
		const screen = nodes[0]
		assert.strictEqual(screen?.kind, "Screen")
		assert.strictEqual(screen?.children.length, 1)
		assert.strictEqual(screen?.children[0]?.children.length, 2)
	})

	it("collects Style rules instead of element children", () => {
		const rules = collectRules(parseVml(counter))
		assert.strictEqual(rules.length, 2)
		assert.deepStrictEqual(
			rules.map((rule) => `${rule.kind}.${rule.className}`),
			["Button.action", "Label.count"],
		)
	})

	it("matches rules by kind and class", () => {
		const nodes = parseVml(counter)
		const rules = collectRules(nodes)
		const button = nodes[0]?.children[0]?.children[0]
		assert.ok(button)
		assert.deepStrictEqual(
			matchingRules(button, rules).map((rule) => `${rule.kind}.${rule.className}`),
			["Button.action"],
		)
	})

	it("lets inline props win over sheet rules", () => {
		const nodes = parseVml(counter)
		const rules = collectRules(nodes)
		const button = nodes[0]?.children[0]?.children[0]
		assert.ok(button)
		const resolved = resolvedDeclarations(button, rules)
		assert.strictEqual(resolved["background"], "#000000")
		assert.strictEqual(resolved["color"], "#FFFFFF")
	})

	it("finds the innermost block for a document line", () => {
		const nodes = parseVml(counter)
		// Line 12 (zero-based) is the `class: card` line inside Rectangle.
		assert.strictEqual(blockAtLine(nodes, 12)?.kind, "Rectangle")
		// Line 13 opens the nested Button, so the innermost block is Button.
		assert.strictEqual(blockAtLine(nodes, 13)?.kind, "Button")
	})

	it("builds hover text with matched rules and applied style", () => {
		const nodes = parseVml(counter)
		const rules = collectRules(nodes)
		const label = nodes[0]?.children[0]?.children[1]
		assert.ok(label)
		const hover = hoverTextFor(label, rules)
		assert.ok(hover.includes("**Label**"))
		assert.ok(hover.includes("Label.count"))
		assert.ok(hover.includes("font-size"))
	})
})

describe("VML reviewer fixes", () => {
	it("parses compact props generically without a whitelist", () => {
		const nodes = parseVml("Screen {\n\tid: heading x: 48 width: 100\n}")
		const screen = nodes[0]
		assert.ok(screen)
		assert.strictEqual(screen.props["id"], "heading")
		assert.strictEqual(screen.props["x"], "48")
		assert.strictEqual(screen.props["width"], "100")
	})

	it("keeps // inside strings and braces inside strings balanced", () => {
		const nodes = parseVml(
			'Screen {\n\tLabel { text: "https://example.test" }\n\tLabel { text: "{" }\n}',
		)
		assert.strictEqual(nodes.length, 1)
		assert.strictEqual(nodes[0]?.children.length, 2)
	})

	it("parses unknown capitalized tags as nodes, not style rules", () => {
		const nodes = parseVml(
			'Screen {\n\tColumn {\n\t\tLabel { text: "hi" }\n\t}\n\tMyWidget {\n\t\tid: custom\n\t}\n\tmyWidget {\n\t\tLabel { text: "low" }\n\t}\n}',
		)
		const kinds = nodes[0]?.children.map((child) => child.kind)
		assert.deepStrictEqual(kinds, ["Column", "MyWidget", "myWidget"])
		assert.strictEqual(nodes[0]?.children[0]?.children[0]?.kind, "Label")
		assert.strictEqual(nodes[0]?.children[2]?.children[0]?.kind, "Label")
		// A selector-shaped header over flat declarations stays a rule.
		const scoped = collectRules(nodes, nodes[0]?.children[1])
		assert.deepStrictEqual(scoped, [])
		const styled = parseVml("Screen {\n\tStyle {\n\t\tColumn.card { width: 10; }\n\t}\n}")
		assert.deepStrictEqual(
			collectRules(styled).map((rule) => `${rule.kind}.${rule.className}`),
			["Column.card"],
		)
	})

	it("scopes rules to the target's ancestor chain", () => {
		const nodes = parseVml(
			"Screen {\n\tStyle {\n\t\tButton { color: red; }\n\t}\n\tView {\n\t\tid: a\n\t\tStyle {\n\t\t\tButton { color: blue; }\n\t\t}\n\t\tButton { id: inner }\n\t}\n\tView {\n\t\tid: b\n\t\tButton { id: other }\n\t}\n}",
		)
		const viewA = nodes[0]?.children[0]
		const viewB = nodes[0]?.children[1]
		assert.ok(viewA && viewB)
		const inner = viewA.children.find((child) => child.props["id"] === "inner")
		const other = viewB.children.find((child) => child.props["id"] === "other")
		assert.ok(inner && other)
		assert.deepStrictEqual(
			collectRules(nodes, inner).map((rule) => rule.declarations["color"]),
			["red", "blue"],
		)
		assert.deepStrictEqual(
			collectRules(nodes, other).map((rule) => rule.declarations["color"]),
			["red"],
		)
	})

	it("matches multi-class values and skips pseudo-class rules", () => {
		const nodes = parseVml(
			'Screen {\n\tStyle {\n\t\tButton.primary { color: one; }\n\t\tButton:hover { color: hovered; }\n\t}\n\tButton { class: "primary big" }\n}',
		)
		const button = nodes[0]?.children[0]
		assert.ok(button)
		const rules = collectRules(nodes, button)
		assert.deepStrictEqual(
			matchingRules(button, rules).map((rule) => `${rule.kind}.${rule.className}`),
			["Button.primary"],
		)
		const resolved = resolvedDeclarations(button, rules)
		assert.strictEqual(resolved["color"], "one")
		const hover = hoverTextFor(button, rules)
		assert.ok(hover.includes("Button:hover"))
		assert.ok(hover.includes("not applied here"))
	})

	it("orders class selectors above kind selectors regardless of source order", () => {
		const nodes = parseVml(
			"Screen {\n\tStyle {\n\t\tButton { color: plain; }\n\t\tButton.action { color: fancy; }\n\t}\n\tButton { class: action }\n}",
		)
		const button = nodes[0]?.children[0]
		assert.ok(button)
		const rules = collectRules(nodes, button)
		assert.deepStrictEqual(
			matchingRules(button, rules).map(
				(rule) => `${rule.kind}${rule.className ? `.${rule.className}` : ""}`,
			),
			["Button", "Button.action"],
		)
		assert.strictEqual(resolvedDeclarations(button, rules)["color"], "fancy")
	})

	it("resolves style attributes and snake_case props", () => {
		const nodes = parseVml(
			'Screen {\n\tStyle {\n\t\tButton { color: sheet; font-size: 1px; }\n\t}\n\tButton {\n\t\tstyle: "color: #123; font_size: 9px"\n\t\tfont_size: 20px\n\t\tcorner_radius: 4\n\t}\n}',
		)
		const button = nodes[0]?.children[0]
		assert.ok(button)
		const resolved = resolvedDeclarations(button, collectRules(nodes, button))
		assert.strictEqual(resolved["color"], "#123")
		assert.strictEqual(resolved["font-size"], "20px")
		assert.strictEqual(resolved["border-radius"], "4")
	})
})

describe("VML review follow-ups", () => {
	it("ignores commented-out blocks in HTML-style comments", () => {
		const nodes = parseVml(
			"Screen {\n\t<!-- Button { id: ghost } -->\n\tButton { id: real }\n}",
		)
		assert.deepStrictEqual(
			nodes[0]?.children.map((child) => child.kind),
			["Button"],
		)
		assert.strictEqual(nodes[0]?.children[0]?.props["id"], "real")
	})

	it("keeps block comments spanning lines from shifting later line numbers", () => {
		const nodes = parseVml(
			"Screen {\n\t<!--\n\t\tButton { id: ghost }\n\t-->\n\tButton { id: real }\n}",
		)
		const real = nodes[0]?.children[0]
		assert.ok(real)
		assert.strictEqual(real.props["id"], "real")
		assert.strictEqual(real.startLine, 4)
	})

	it("keeps block comment markers inside strings", () => {
		const nodes = parseVml('Screen {\n\tLabel { text: "<!-- kept -->" }\n}')
		assert.strictEqual(nodes[0]?.children.length, 1)
		assert.strictEqual(nodes[0]?.children[0]?.props["text"], '"<!-- kept -->"')
	})

	it("resolves same-line siblings by cursor column", () => {
		const doc = "Screen { Button { id: first } Label { id: second } }"
		const nodes = parseVml(doc)
		assert.strictEqual(blockAtPosition(nodes, 0, doc.indexOf("first"))?.props["id"], "first")
		assert.strictEqual(blockAtPosition(nodes, 0, doc.indexOf("second"))?.props["id"], "second")
		// The gap between the siblings belongs to the parent block.
		const gap = doc.indexOf("} L")
		assert.strictEqual(blockAtPosition(nodes, 0, gap + 1)?.kind, "Screen")
	})

	it("keeps flat lowercase blocks as component nodes", () => {
		const nodes = parseVml("Screen {\n\tmyWidget { id: custom }\n}")
		assert.deepStrictEqual(
			nodes[0]?.children.map((child) => child.kind),
			["myWidget"],
		)
		assert.strictEqual(nodes[0]?.children[0]?.props["id"], "custom")
		// Hovering the widget resolves to it, not to its parent.
		assert.strictEqual(blockAtPosition(nodes, 1, 4)?.kind, "myWidget")
	})
})

describe("VML round-2 reviewer fixes", () => {
	it("skips VSS block comments while balancing braces", () => {
		const nodes = parseVml(
			"Screen {\n\tStyle {\n\t\t/* } */\n\t\tButton { color: red; }\n\t}\n\tButton { id: real }\n}",
		)
		assert.deepStrictEqual(
			nodes[0]?.children.map((child) => child.kind),
			["Button"],
		)
		const rules = collectRules(nodes)
		assert.deepStrictEqual(
			rules.map((rule) => rule.selector),
			["Button"],
		)
		const button = nodes[0]?.children[0]
		assert.ok(button)
		assert.strictEqual(
			resolvedDeclarations(button, collectRules(nodes, button))["color"],
			"red",
		)
	})

	it("keeps VSS block comment markers inside strings", () => {
		const nodes = parseVml('Screen {\n\tLabel { text: "/* kept */" }\n}')
		assert.strictEqual(nodes[0]?.children.length, 1)
		assert.strictEqual(nodes[0]?.children[0]?.props["text"], '"/* kept */"')
	})

	it("handles Button#login, .card and descendant selectors", () => {
		const nodes = parseVml(
			"Screen {\n\tStyle {\n\t\tButton#login { color: one; }\n\t\t.card { color: two; }\n\t\tScreen Button { color: three; }\n\t}\n\tButton { id: login }\n\tRectangle { class: card }\n\tButton { id: other }\n}",
		)
		assert.deepStrictEqual(
			collectRules(nodes)
				.map((rule) => rule.selector)
				.sort(),
			[".card", "Button#login", "Screen Button"].sort(),
		)
		const login = nodes[0]?.children.find((child) => child.props["id"] === "login")
		const card = nodes[0]?.children.find((child) => child.kind === "Rectangle")
		const other = nodes[0]?.children.find((child) => child.props["id"] === "other")
		assert.ok(login && card && other)
		// An id rule beats a descendant kind rule on the same node.
		assert.deepStrictEqual(
			matchingRules(login, collectRules(nodes, login), ancestorsOf(nodes, login)).map(
				(rule) => rule.selector,
			),
			["Screen Button", "Button#login"],
		)
		assert.deepStrictEqual(
			matchingRules(card, collectRules(nodes, card), ancestorsOf(nodes, card)).map(
				(rule) => rule.selector,
			),
			[".card"],
		)
		// A plain Button still matches the descendant rule through Screen.
		assert.deepStrictEqual(
			matchingRules(other, collectRules(nodes, other), ancestorsOf(nodes, other)).map(
				(rule) => rule.selector,
			),
			["Screen Button"],
		)
	})

	it("maps bold and italic props over sheet typography", () => {
		const nodes = parseVml(
			"Screen {\n\tStyle {\n\t\tLabel { font-weight: normal; font-style: normal; }\n\t}\n\tLabel { bold: true italic: true }\n}",
		)
		const label = nodes[0]?.children[0]
		assert.ok(label)
		const resolved = resolvedDeclarations(
			label,
			collectRules(nodes, label),
			ancestorsOf(nodes, label),
			collectVariables(nodes, label),
		)
		assert.strictEqual(resolved["font-weight"], "bold")
		assert.strictEqual(resolved["font-style"], "italic")
	})

	it("resolves VSS variables before reporting applied values", () => {
		const nodes = parseVml(
			"Screen {\n\tStyle {\n\t\t@brand: #3478D4;\n\t\tButton { background: @brand; }\n\t}\n\tButton { id: x }\n}",
		)
		const button = nodes[0]?.children[0]
		assert.ok(button)
		const rules = collectRules(nodes, button)
		const vars = collectVariables(nodes, button)
		assert.strictEqual(vars["@brand"], "#3478D4")
		const resolved = resolvedDeclarations(button, rules, ancestorsOf(nodes, button), vars)
		assert.strictEqual(resolved["background"], "#3478D4")
		const hover = hoverTextFor(button, rules, ancestorsOf(nodes, button), vars)
		assert.ok(hover.includes("#3478D4"))
		assert.ok(!hover.includes("@brand"))
	})
})

describe("VML round-3 reviewer fixes", () => {
	it("flattens nested rules into descendant selectors", () => {
		const nodes = parseVml(
			"Screen {\n\tStyle {\n\t\tView.card {\n\t\t\tbackground: red;\n\t\t\tLabel.title { color: blue; }\n\t\t\tLabel, Button { margin: 1px; }\n\t\t}\n\t}\n\tView {\n\t\tclass: card\n\t\tLabel { class: title }\n\t\tButton { id: plain }\n\t}\n}",
		)
		const view = nodes[0]?.children[0]
		const label = view?.children[0]
		const button = view?.children[1]
		assert.ok(view && label && button)
		assert.deepStrictEqual(
			collectRules(nodes)
				.map((rule) => rule.selector)
				.sort(),
			["View.card", "View.card Button", "View.card Label", "View.card Label.title"].sort(),
		)
		assert.deepStrictEqual(
			matchingRules(label, collectRules(nodes, label), ancestorsOf(nodes, label)).map(
				(rule) => rule.selector,
			),
			["View.card Label", "View.card Label.title"],
		)
		const resolvedLabel = resolvedDeclarations(
			label,
			collectRules(nodes, label),
			ancestorsOf(nodes, label),
		)
		assert.strictEqual(resolvedLabel["color"], "blue")
		// `margin` parses but is layout-owned in v1, so it never applies.
		assert.strictEqual(resolvedLabel["margin"], undefined)
		assert.strictEqual(resolvedLabel["background"], undefined)
		assert.strictEqual(
			resolvedDeclarations(view, collectRules(nodes, view))["background"],
			"red",
		)
		assert.deepStrictEqual(
			matchingRules(button, collectRules(nodes, button), ancestorsOf(nodes, button)).map(
				(rule) => rule.selector,
			),
			["View.card Button"],
		)
	})

	it("excludes media and container rules from static matching", () => {
		const nodes = parseVml(
			"Screen {\n\tStyle {\n\t\tButton { color: red; }\n\t\t@media (max-width: 600px) {\n\t\t\tButton { color: blue; }\n\t\t}\n\t\t@container sidebar (min-width: 300px) {\n\t\t\tButton { color: green; }\n\t\t}\n\t}\n\tButton { id: b }\n}",
		)
		const button = nodes[0]?.children[0]
		assert.ok(button)
		const rules = collectRules(nodes, button)
		assert.strictEqual(rules.length, 3)
		assert.deepStrictEqual(
			rules.filter((rule) => rule.condition).map((rule) => rule.condition),
			["@media (max-width: 600px)", "@container sidebar (min-width: 300px)"],
		)
		assert.deepStrictEqual(
			matchingRules(button, rules, ancestorsOf(nodes, button)).map(
				(rule) => rule.declarations["color"],
			),
			["red"],
		)
		assert.strictEqual(
			resolvedDeclarations(button, rules, ancestorsOf(nodes, button))["color"],
			"red",
		)
		const hover = hoverTextFor(button, rules, ancestorsOf(nodes, button))
		assert.ok(hover.includes("Conditional rules (not applied here):"))
		assert.ok(hover.includes("@media (max-width: 600px)"))
		assert.ok(hover.includes("@container sidebar (min-width: 300px)"))
	})

	it("requires adjacency for child combinators", () => {
		const nodes = parseVml(
			"Screen {\n\tStyle {\n\t\tScreen > Button { color: child; }\n\t\tScreen Button { color: descendant; }\n\t}\n\tView {\n\t\tButton { id: deep }\n\t}\n\tButton { id: direct }\n}",
		)
		const view = nodes[0]?.children[0]
		const deep = view?.children[0]
		const direct = nodes[0]?.children[1]
		assert.ok(view && deep && direct)
		assert.deepStrictEqual(
			matchingRules(direct, collectRules(nodes, direct), ancestorsOf(nodes, direct)).map(
				(rule) => rule.selector,
			),
			["Screen > Button", "Screen Button"],
		)
		assert.deepStrictEqual(
			matchingRules(deep, collectRules(nodes, deep), ancestorsOf(nodes, deep)).map(
				(rule) => rule.selector,
			),
			["Screen Button"],
		)
	})

	it("keeps // inside url() values", () => {
		const nodes = parseVml(
			"Screen {\n\tStyle {\n\t\tButton { background-image: url(http://example.test/image.png); color: red; } // trailing\n\t}\n\tButton { id: b }\n}",
		)
		const button = nodes[0]?.children[0]
		assert.ok(button)
		const rules = collectRules(nodes, button)
		// The declaration still parses with the URL intact; `background-image`
		// is unknown to UI2, so it is collected but never reported as applied.
		assert.strictEqual(
			matchingRules(button, rules, ancestorsOf(nodes, button))[0]?.declarations[
				"background-image"
			],
			"url(http://example.test/image.png)",
		)
		const resolved = resolvedDeclarations(button, rules)
		assert.strictEqual(resolved["background-image"], undefined)
		assert.strictEqual(resolved["color"], "red")
	})

	it("collects grouped selectors as one rule per group", () => {
		const nodes = parseVml(
			"Button, Label { color: red; }\nScreen {\n\tStyle {\n\t\tButton, Label { color: blue; }\n\t}\n\tButton { id: b }\n\tLabel { id: l }\n\tView { id: v }\n}",
		)
		const screen = nodes[0]
		const button = screen?.children[0]
		const label = screen?.children[1]
		const view = screen?.children[2]
		assert.ok(screen && button && label && view)
		const rules = collectRules(nodes, button)
		assert.deepStrictEqual(
			rules.map((rule) => rule.selector).sort(),
			["Button", "Button", "Label", "Label"].sort(),
		)
		assert.deepStrictEqual(
			matchingRules(button, rules, ancestorsOf(nodes, button)).map((rule) => rule.selector),
			["Button", "Button"],
		)
		assert.deepStrictEqual(
			matchingRules(label, collectRules(nodes, label), ancestorsOf(nodes, label)).map(
				(rule) => rule.selector,
			),
			["Label", "Label"],
		)
		assert.deepStrictEqual(matchingRules(view, collectRules(nodes, view)), [])
	})

	it("applies structural pseudo-classes and keeps dynamic ones conditional", () => {
		const nodes = parseVml(
			"Screen {\n\tStyle {\n\t\tButton:first-child { color: first; }\n\t\tButton:nth-child(2) { color: second; }\n\t\tButton:hover { color: hovered; }\n\t}\n\tButton { id: a }\n\tButton { id: b }\n}",
		)
		const first = nodes[0]?.children[0]
		const second = nodes[0]?.children[1]
		assert.ok(first && second)
		const firstRules = collectRules(nodes, first)
		const secondRules = collectRules(nodes, second)
		assert.deepStrictEqual(
			matchingRules(first, firstRules, ancestorsOf(nodes, first)).map(
				(rule) => rule.selector,
			),
			["Button:first-child"],
		)
		assert.deepStrictEqual(
			matchingRules(second, secondRules, ancestorsOf(nodes, second)).map(
				(rule) => rule.selector,
			),
			["Button:nth-child(2)"],
		)
		assert.strictEqual(resolvedDeclarations(first, firstRules)["color"], "first")
		assert.strictEqual(
			resolvedDeclarations(second, secondRules, ancestorsOf(nodes, second))["color"],
			"second",
		)
		const hover = hoverTextFor(second, secondRules, ancestorsOf(nodes, second))
		assert.ok(hover.includes("Button:nth-child(2)"))
		assert.ok(hover.includes("State-dependent rules (not applied here):"))
		assert.ok(hover.includes("Button:hover"))
		assert.ok(!hover.includes("Button:first-child"))
	})

	it("matches type selectors case-insensitively", () => {
		const nodes = parseVml(
			"Screen {\n\tStyle {\n\t\tbutton { color: low; }\n\t\t.Button { color: classy; }\n\t}\n\tButton { id: b }\n\tButton { id: c class: Button }\n}",
		)
		const plain = nodes[0]?.children[0]
		const classy = nodes[0]?.children[1]
		assert.ok(plain && classy)
		assert.deepStrictEqual(
			matchingRules(plain, collectRules(nodes, plain), ancestorsOf(nodes, plain)).map(
				(rule) => rule.selector,
			),
			["button"],
		)
		assert.deepStrictEqual(
			matchingRules(classy, collectRules(nodes, classy), ancestorsOf(nodes, classy)).map(
				(rule) => rule.selector,
			),
			["button", ".Button"],
		)
	})
})

describe("VML round-4 reviewer fixes", () => {
	it("matches selectors against UI2 element kinds", () => {
		const nodes = parseVml(
			"Screen {\n\tStyle {\n\t\tview { color: applied; }\n\t\tRectangle { color: bogus; }\n\t\ttext_field { color: field; }\n\t}\n\tRectangle { id: card }\n\tTextField { id: input }\n\tMyWidget { id: custom }\n}",
		)
		const rect = nodes[0]?.children[0]
		const field = nodes[0]?.children[1]
		const custom = nodes[0]?.children[2]
		assert.ok(rect && field && custom)
		// `view` applies to a Rectangle at runtime, while a `Rectangle`
		// rule never matches anything.
		assert.deepStrictEqual(
			matchingRules(rect, collectRules(nodes, rect), ancestorsOf(nodes, rect)).map(
				(rule) => rule.selector,
			),
			["view"],
		)
		assert.strictEqual(
			resolvedDeclarations(rect, collectRules(nodes, rect), ancestorsOf(nodes, rect))[
				"color"
			],
			"applied",
		)
		// TextField elements carry the text_field kind.
		assert.deepStrictEqual(
			matchingRules(field, collectRules(nodes, field), ancestorsOf(nodes, field)).map(
				(rule) => rule.selector,
			),
			["text_field"],
		)
		// Imported/custom widgets build as views.
		assert.deepStrictEqual(
			matchingRules(custom, collectRules(nodes, custom), ancestorsOf(nodes, custom)).map(
				(rule) => rule.selector,
			),
			["view"],
		)
	})

	it("resolves CSS custom properties and var() fallbacks", () => {
		const nodes = parseVml(
			"Screen {\n\tStyle {\n\t\t--brand: #3478D4;\n\t\tButton { background: var(--brand); border-color: var(--missing, #112233); color: --brand; }\n\t}\n\tButton { id: b }\n}",
		)
		const button = nodes[0]?.children[0]
		assert.ok(button)
		const resolved = resolvedDeclarations(
			button,
			collectRules(nodes, button),
			ancestorsOf(nodes, button),
			collectVariables(nodes, button),
		)
		assert.strictEqual(resolved["background"], "#3478D4")
		assert.strictEqual(resolved["border-color"], "#112233")
		assert.strictEqual(resolved["color"], "#3478D4")
	})

	it("collects light/dark theme variables", () => {
		const nodes = parseVml(
			"light { @top: #333333; }\nScreen {\n\tStyle {\n\t\tlight { @brand: #111111; }\n\t\tdark { @brand: #222222; }\n\t\tButton { background: @brand; color: @top; }\n\t}\n\tButton { id: b }\n}",
		)
		const button = nodes[0]?.children[0]
		assert.ok(button)
		const vars = collectVariables(nodes, button)
		assert.ok(vars["@brand"] !== undefined && vars["@brand"] !== "@brand")
		// Later blocks win, mirroring the cascade merge.
		assert.strictEqual(vars["@brand"], "#222222")
		const resolved = resolvedDeclarations(
			button,
			collectRules(nodes, button),
			ancestorsOf(nodes, button),
			vars,
		)
		assert.strictEqual(resolved["background"], "#222222")
		assert.strictEqual(resolved["color"], "#333333")
	})

	it("requires no text for :empty", () => {
		const nodes = parseVml(
			'Screen {\n\tStyle {\n\t\tLabel:empty { color: empty; }\n\t}\n\tLabel { id: blank }\n\tLabel { id: text text: "hi" }\n\tLabel { id: styled Style { Button { color: red; } } }\n}',
		)
		const blank = nodes[0]?.children[0]
		const text = nodes[0]?.children[1]
		const styled = nodes[0]?.children[2]
		assert.ok(blank && text && styled)
		assert.deepStrictEqual(
			matchingRules(blank, collectRules(nodes, blank), ancestorsOf(nodes, blank)).map(
				(rule) => rule.selector,
			),
			["Label:empty"],
		)
		// A Label with text is not empty even without children.
		assert.deepStrictEqual(
			matchingRules(text, collectRules(nodes, text), ancestorsOf(nodes, text)),
			[],
		)
		// A Style child never renders, so it does not count either.
		assert.deepStrictEqual(
			matchingRules(styled, collectRules(nodes, styled), ancestorsOf(nodes, styled)).map(
				(rule) => rule.selector,
			),
			["Label:empty"],
		)
	})

	it("hides layout-owned and unknown declarations from applied style", () => {
		const nodes = parseVml(
			"Screen {\n\tStyle {\n\t\tButton { padding: 5px; margin: 1px; gap: 2px; color: red; bogus-prop: 1px; transition-duration: 0.2s; }\n\t}\n\tButton { id: b }\n}",
		)
		const button = nodes[0]?.children[0]
		assert.ok(button)
		const rules = collectRules(nodes, button)
		const resolved = resolvedDeclarations(button, rules, ancestorsOf(nodes, button))
		assert.strictEqual(resolved["color"], "red")
		// Driver-owned animation declarations do apply.
		assert.strictEqual(resolved["transition-duration"], "0.2s")
		// Layout-owned and unknown properties never apply at runtime.
		assert.strictEqual(resolved["padding"], undefined)
		assert.strictEqual(resolved["margin"], undefined)
		assert.strictEqual(resolved["gap"], undefined)
		assert.strictEqual(resolved["bogus-prop"], undefined)
		const hover = hoverTextFor(button, rules, ancestorsOf(nodes, button))
		assert.ok(hover.includes("color"))
		assert.ok(!hover.includes("bogus-prop"))
		assert.ok(!hover.includes("padding"))
	})

	it("treats only UI2-supported pseudos as structural", () => {
		const nodes = parseVml(
			"Screen {\n\tStyle {\n\t\tButton:first-of-type { color: typo; }\n\t\tButton:root { color: rooted; }\n\t\tButton:first-child { color: first; }\n\t}\n\tButton { id: a }\n\tButton { id: b }\n}",
		)
		const first = nodes[0]?.children[0]
		assert.ok(first)
		const rules = collectRules(nodes, first)
		// The runtime parser rejects :-of-type and :root, so only the
		// supported structural rule matches statically.
		assert.deepStrictEqual(
			matchingRules(first, rules, ancestorsOf(nodes, first)).map((rule) => rule.selector),
			["Button:first-child"],
		)
		const hover = hoverTextFor(first, rules, ancestorsOf(nodes, first))
		assert.ok(hover.includes("Button:first-child"))
		assert.ok(hover.includes("State-dependent"))
		assert.ok(hover.includes("Button:first-of-type"))
		assert.ok(hover.includes("Button:root"))
	})

	it("orders specificity in UI2 buckets", () => {
		const nodes = parseVml(
			'Screen {\n\tStyle {\n\t\t.a.b.c.d.e.f.g.h.i.j.k { color: many; }\n\t\t#pick { color: single; }\n\t}\n\tButton { id: pick class: "a b c d e f g h i j k" }\n}',
		)
		const button = nodes[0]?.children[0]
		assert.ok(button)
		const rules = collectRules(nodes, button)
		assert.deepStrictEqual(
			matchingRules(button, rules, ancestorsOf(nodes, button)).map((rule) => rule.selector),
			[".a.b.c.d.e.f.g.h.i.j.k", "#pick"],
		)
		// Eleven classes still lose to one id: buckets, not points.
		assert.strictEqual(
			resolvedDeclarations(button, rules, ancestorsOf(nodes, button))["color"],
			"single",
		)
	})
})
