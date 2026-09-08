import { readFile } from "node:fs/promises";
import type { StudioSnapshot } from "../../packages/decorator-agent/src/services/studio.js";

export interface RoomFixture {
	provenance: "synthetic" | "database-export";
	sourceDescription: string;
	coordinates: {
		units: "metres";
		axes: "+X right,+Y back,+Z up";
		origin: "floor front-left";
		rotation: "XYZ radians; yaw only";
	};
	snapshot: StudioSnapshot;
}

function object(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`Fixture: ${path} must be an object`);
	return value as Record<string, unknown>;
}

function string(value: unknown, path: string): asserts value is string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`Fixture: ${path} is required`);
}

function vector(value: unknown, path: string, length = 3): asserts value is number[] {
	if (
		!Array.isArray(value) ||
		value.length !== length ||
		!value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
	)
		throw new Error(`Fixture: ${path} needs ${length} finite numbers`);
}

export function validateSnapshot(value: unknown): asserts value is StudioSnapshot {
	const room = object(value, "snapshot");
	string(room.designId, "designId");
	string(room.revision, "revision");
	const geometry = object(room.geometry, "geometry");
	if (typeof geometry.height !== "number" || !Number.isFinite(geometry.height) || geometry.height <= 0)
		throw new Error("Fixture: positive geometry.height required");
	if (!Array.isArray(geometry.floor) || geometry.floor.length < 3)
		throw new Error("Fixture: geometry.floor needs at least three vertices");
	geometry.floor.forEach((point, index) => {
		vector(point, `geometry.floor[${index}]`, 2);
	});
	if (!Array.isArray(room.openings)) throw new Error("Fixture: openings array required (empty only when verified)");
	const openingIds = new Set<string>();
	for (const value of room.openings) {
		const opening = object(value, "opening");
		string(opening.id, "opening.id");
		if (openingIds.has(opening.id)) throw new Error(`Fixture: duplicate opening ${opening.id}`);
		openingIds.add(opening.id);
		if (opening.kind !== "door" && opening.kind !== "window")
			throw new Error("Fixture: opening.kind must be door/window");
		vector(opening.position, "opening.position");
		vector(opening.dimensions, "opening.dimensions");
		if (opening.dimensions.some((number) => number <= 0))
			throw new Error("Fixture: opening dimensions must be positive");
	}
	if (!Array.isArray(room.objects)) throw new Error("Fixture: objects array required");
	const ids = new Set<string>();
	for (const value of room.objects) {
		const entry = object(value, "object");
		string(entry.id, "object.id (placed instance ID, never a catalog ID)");
		if (ids.has(entry.id)) throw new Error(`Fixture: duplicate instance ID ${entry.id}`);
		ids.add(entry.id);
		string(entry.name, `${entry.id}.name`);
		string(entry.category, `${entry.id}.category`);
		for (const field of ["position", "rotation", "scale", "dimensions"]) vector(entry[field], `${entry.id}.${field}`);
		if (
			(entry.scale as number[]).some((number) => number <= 0) ||
			(entry.dimensions as number[]).some((number) => number <= 0)
		)
			throw new Error(`Fixture: ${entry.id} requires positive scale/dimensions`);
		if ((entry.rotation as number[])[0] !== 0 || (entry.rotation as number[])[1] !== 0)
			throw new Error(`Fixture: ${entry.id} has unsupported non-yaw rotation`);
	}
	if (
		!Array.isArray(room.selectedObjectIds) ||
		room.selectedObjectIds.some((id) => typeof id !== "string" || !ids.has(id)) ||
		new Set(room.selectedObjectIds).size !== room.selectedObjectIds.length
	)
		throw new Error("Fixture: selectedObjectIds must contain unique existing instance IDs");
}

export async function readRoom(path: string): Promise<RoomFixture> {
	const value: unknown = JSON.parse(await readFile(path, "utf8"));
	const fixture = object(value, "root");
	if (fixture.provenance !== "synthetic" && fixture.provenance !== "database-export")
		throw new Error("Fixture: explicitly label provenance synthetic or database-export");
	string(fixture.sourceDescription, "sourceDescription");
	const coordinates = object(fixture.coordinates, "coordinates");
	if (
		coordinates.units !== "metres" ||
		coordinates.axes !== "+X right,+Y back,+Z up" ||
		coordinates.origin !== "floor front-left" ||
		coordinates.rotation !== "XYZ radians; yaw only"
	)
		throw new Error(
			"Fixture: explicitly mapped manifest coordinate conventions required; see docs/Studio-Contract.md",
		);
	validateSnapshot(fixture.snapshot);
	return value as RoomFixture;
}
