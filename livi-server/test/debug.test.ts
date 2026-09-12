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

test("debug renders readable actions while redacting sensitive payloads", () => {
	const lines: string[] = [];
	const debug = createDebugLogger(true, (line) => lines.push(line));
	debug?.("tool.start", {
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
		catalogDatabaseUrl: "postgres://user:credential-marker@host/db",
	});
	assert.equal(lines.length, 1);
	const line = lines[0] ?? "";
	assert.match(line, /^\[\d{2}:\d{2}:\d{2}\] tool start move_object /);
	assert.ok(line.includes('arguments={"objectId":"sofa_17","position":[1,2,0],"apiKey":"[redacted]"}'));
	assert.ok(line.includes("promptLength=30"));
	assert.ok(!line.includes("-marker"));
	assert.doesNotMatch(line, /sessionId|operationId|invocationId|commandId|toolName/);
});

test("debug suppresses connection and context noise and keeps tool steps in order", () => {
	const lines: string[] = [];
	const debug = createDebugLogger(true, (line) => lines.push(line));
	debug?.("connection.accepted", { connectionId: "connection", origin: "http://localhost:3000" });
	debug?.("context.ready", { available: true, revision: "28" });
	debug?.("tool.start", {
		sessionId: "session",
		operationId: "operation",
		turnId: "turn",
		invocationId: "invocation",
		commandId: "command",
		connectionId: "connection",
		requestId: "request",
		messageLength: 32,
		mutationBlocked: false,
		toolName: "get_room_context",
		arguments: {},
	});
	debug?.("tool.result", { toolName: "get_room_context", status: "ready", objectCount: 6 });
	debug?.("tool.error", { toolName: "move_object", errorCode: "tool_failed" });
	debug?.("connection.closed", { connectionId: "connection" });
	assert.deepEqual(
		lines.map((line) => line.replace(/^\[\d{2}:\d{2}:\d{2}\] /, "")),
		[
			"tool start get_room_context",
			"tool result get_room_context status=ready objectCount=6",
			"tool error move_object errorCode=tool_failed",
		],
	);
});

test("debug sink failures cannot affect tool behavior", () => {
	const debug = createDebugLogger(true, () => {
		throw new Error("closed stream");
	});
	assert.doesNotThrow(() => debug?.("tool.finished", { status: "saved" }));
});
