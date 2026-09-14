import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { hideInternalIds } from "../src/message-markdown.ts";

const id = "a7e72bb2-86a3-464c-87fd-920eb8ad5b56";

test("assistant markdown hides parenthesized UUIDs while preserving product facts and formatting", () => {
	const html = renderToStaticMarkup(
		createElement(Markdown, {
			rehypePlugins: [hideInternalIds],
			children: `**Wood Coffee Table** (${id}) – $126.37\n\nDimensions: 1.10 m × 0.50 m`,
		}),
	);
	assert.equal(html, "<p><strong>Wood Coffee Table</strong> – $126.37</p>\n<p>Dimensions: 1.10 m × 0.50 m</p>");
});

test("assistant markdown hides bare and code UUIDs but preserves actionable link targets", () => {
	const html = renderToStaticMarkup(
		createElement(Markdown, {
			rehypePlugins: [hideInternalIds],
			children: `Table ${id.toUpperCase()} selected.\n\n\`${id}\`\n\n[View product](https://shop.example/${id})`,
		}),
	);
	assert.match(html, /Table selected\./);
	assert.doesNotMatch(html, /<code>/);
	assert.ok(html.includes(`href="https://shop.example/${id}"`));
	assert.equal(html.split(id).length - 1, 1);
});

test("assistant markdown removes empty parentheses around hidden formatted IDs", () => {
	for (const reference of [id, `\`${id}\``, `**${id}**`, `[${id}](https://shop.example/${id})`]) {
		const html = renderToStaticMarkup(
			createElement(Markdown, {
				rehypePlugins: [hideInternalIds],
				children: `Mid-century Wood Coffee Table (${reference}) – $716.00 (Walnut)`,
			}),
		);
		assert.equal(html, "<p>Mid-century Wood Coffee Table – $716.00 (Walnut)</p>");
	}
});

test("UUID removal preserves parentheses around remaining descriptions", () => {
	for (const [message, expected] of [
		[`Rug (id ${id})`, "Rug (id)"],
		[`Chair (see ${id}) here`, "Chair (see) here"],
		[`Table (${id}, walnut)`, "Table (walnut)"],
		[`Table (walnut, ${id})`, "Table (walnut)"],
		[`Table (\`${id}\`, walnut)`, "Table (walnut)"],
		[`Table (walnut, **${id}**)`, "Table (walnut)"],
		[`Lamp (${id}) ok`, "Lamp ok"],
	]) {
		const html = renderToStaticMarkup(createElement(Markdown, { rehypePlugins: [hideInternalIds], children: message }));
		assert.equal(html, `<p>${expected}</p>`);
	}
});

 test("UUID cleanup preserves ordinary parentheses and code", () => {
	for (const message of [
		"Call foo() then bar().",
		"Use `useEffect(() => {})` here",
		"```js\nconst f = () => {}; foo();\n```",
		"Plain () parentheses",
	]) {
		const original = renderToStaticMarkup(createElement(Markdown, { children: message }));
		const hidden = renderToStaticMarkup(createElement(Markdown, { rehypePlugins: [hideInternalIds], children: message }));
		assert.equal(hidden, original);
	}
	const mixed = renderToStaticMarkup(createElement(Markdown, {
		rehypePlugins: [hideInternalIds], children: `Call foo() for table (${id}).`,
	}));
	assert.equal(mixed, "<p>Call foo() for table.</p>");
});
