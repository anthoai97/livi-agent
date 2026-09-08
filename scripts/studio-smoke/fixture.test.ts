import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertJson } from "./assertions.js";
import { readRoom, validateSnapshot } from "./room.js";

const path = new URL("./fixtures/synthetic-room.json", import.meta.url);

test("room exports reject missing evidence, duplicate instance IDs, and unsupported rotations", async () => {
	const original = JSON.parse(await readFile(path, "utf8")) as { snapshot: Record<string, unknown> };
	validateSnapshot(original.snapshot);
	for (const required of ["designId", "revision", "geometry", "openings", "objects", "selectedObjectIds"]) {
		const snapshot = structuredClone(original.snapshot);
		delete snapshot[required];
		assert.throws(() => validateSnapshot(snapshot), /Fixture:/, `Missing ${required} must not receive a default`);
	}
	for (const required of ["id", "position", "rotation", "scale", "dimensions"]) {
		const snapshot = structuredClone(original.snapshot);
		Reflect.deleteProperty(snapshot.objects[0]!, required);
		assert.throws(() => validateSnapshot(snapshot), /Fixture:/);
	}
	const fixture = await readRoom(path.pathname);
	const duplicate = structuredClone(fixture.snapshot);
	duplicate.objects[1]!.id = duplicate.objects[0]!.id;
	assert.throws(() => validateSnapshot(duplicate), /duplicate instance/);
	const tilted = structuredClone(fixture.snapshot);
	tilted.objects[0]!.rotation = [0.1, 0, 0];
	assert.throws(() => validateSnapshot(tilted), /non-yaw/);
	const infinite = structuredClone(fixture.snapshot);
	infinite.objects[0]!.position[0] = Infinity;
	assert.throws(() => validateSnapshot(infinite), /finite numbers/);
});

test("independent assertions catch unintended material changes while tolerating numeric normalization", () => {
	const before = { position: [1, 2, 0], material: { color: "red" } };
	const after = { position: [1.50001, 2, 0], material: { color: "blue" } };
	const checks = assertJson(before, after, [
		{ path: "/position", equals: [1.5, 2, 0], tolerance: 0.0001 },
		{ path: "/material", unchanged: true },
		{ path: "/position", equals: [1.5, 2, 0], tolerance: 0.000001 },
	]);
	assert.deepEqual(
		checks.map((check) => check.passed),
		[true, false, false],
	);
	assert.equal(assertJson({}, [], [{ path: "", unchanged: true }])[0]!.passed, false);
});
