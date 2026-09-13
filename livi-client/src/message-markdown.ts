interface MarkdownNode {
	type: string;
	tagName?: string;
	value?: string;
	children?: MarkdownNode[];
}

/** Hide internal UUIDs in visible text without changing link targets or saved messages. */
export function hideInternalIds() {
	const uuid = String.raw`\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b`;
	return function transform(node: MarkdownNode): void {
		if (!node.children) return;
		const children: MarkdownNode[] = [];
		for (const child of node.children) {
			transform(child);
			const previous = children.at(-1);
			if (previous?.type === "text" && child.type === "text") {
				previous.value = `${previous.value ?? ""}${child.value ?? ""}`;
			} else {
				children.push(child);
			}
		}
		// Unwrap formatted IDs before removing them so their surrounding punctuation stays together.
		if (
			["code", "em", "strong", "a", "del"].includes(node.tagName ?? "") &&
			children.length === 1 &&
			children[0]?.type === "text" &&
			new RegExp(`^\\s*${uuid}\\s*$`, "i").test(children[0].value ?? "")
		) {
			node.type = "text";
			node.value = children[0].value;
			delete node.tagName;
			delete node.children;
			return;
		}
		for (const child of children) {
			if (child.type !== "text" || !child.value) continue;
			child.value = child.value
				.replace(new RegExp(String.raw`[ \t]*\([ \t]*${uuid}[ \t]*\)`, "gi"), "")
				.replace(new RegExp(String.raw`\([ \t]*${uuid}[ \t]*,[ \t]*`, "gi"), "(")
				.replace(new RegExp(String.raw`,[ \t]*${uuid}[ \t]*\)`, "gi"), ")")
				.replace(new RegExp(String.raw`[ \t]*${uuid}`, "gi"), "");
		}
		node.children = children.filter((child) => child.type !== "text" || child.value);
	};
}
