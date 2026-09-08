import assert from "node:assert/strict";
import { test } from "node:test";
import { createDebugLogger } from "../src/debug.js";

test("debug is quiet unless enabled", () => {
	const lines: string[] = [];
	const debug = createDebugLogger(false, (line) => lines.push(line));
	debug?.("tool.started", { sessionId: "session" });
	assert.equal(debug, undefined);
	assert.deepEqual(lines, []);
});

test("debug preserves correlation and action fields while redacting sensitive payloads", () => {
	const lines: string[] = [];
	const debug = createDebugLogger(true, (line) => lines.push(line));
	debug?.("tool.started", {
		sessionId: "session",
		operationId: "operation",
		invocationId: "invocation",
		commandId: "command",
		toolName: "move_object",
		arguments: { objectId: "sofa_17", position: [1, 2, 0], apiKey: "credential-marker" },
		promptLength: 30,
		prompt: "prompt-marker",
		headers: { authorization: "auth-marker" },
		thinking: "thinking-marker",
		signature: "signature-marker",
		snapshot: { objects: [{ name: "snapshot-marker" }] },
		geometry: { floor: "geometry-marker" },
		payload: "payload-marker",
		error: "raw-error-marker",
		exception: new Error("exception-marker"),
	});
	assert.equal(lines.length, 1);
	const record = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
	assert.equal(record.event, "tool.started");
	assert.equal(record.sessionId, "session");
	assert.equal(record.operationId, "operation");
	assert.equal(record.invocationId, "invocation");
	assert.equal(record.commandId, "command");
	assert.equal(record.promptLength, 30);
	assert.equal(typeof record.timestamp, "string");
	assert.ok(Number.isFinite(Date.parse(String(record.timestamp))));
	assert.deepEqual(record.arguments, { objectId: "sofa_17", position: [1, 2, 0], apiKey: "[redacted]" });
	assert.ok(!lines[0]?.includes("-marker"));
});

test("debug sink failures cannot affect tool behavior", () => {
	const debug = createDebugLogger(true, () => {
		throw new Error("closed stream");
	});
	assert.doesNotThrow(() => debug?.("tool.finished", { status: "saved" }));
});
