import { isDeepStrictEqual } from "node:util";

export interface JsonAssertion {
	path: string;
	equals?: unknown;
	unchanged?: boolean;
	absent?: boolean;
	tolerance?: number;
}

export interface AssertionResult {
	assertion: string;
	passed: boolean;
	expected: unknown;
	actual: unknown;
}

/** Explicit JSON pointers let export-specific cases assert fields outside the room contract, too. */
export function atPath(value: unknown, pointer: string): unknown {
	if (pointer === "") return value;
	if (!pointer.startsWith("/")) throw new Error(`Expected JSON pointer: ${pointer}`);
	let current = value;
	for (const encoded of pointer.slice(1).split("/")) {
		const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
		if (typeof current !== "object" || current === null || !Object.hasOwn(current, key)) return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

function equivalent(actual: unknown, expected: unknown, tolerance: number): boolean {
	if (Array.isArray(actual) !== Array.isArray(expected)) return false;
	if (typeof actual === "number" && typeof expected === "number")
		return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= tolerance;
	if (Array.isArray(actual) && Array.isArray(expected))
		return (
			actual.length === expected.length &&
			actual.every((value, index) => equivalent(value, expected[index], tolerance))
		);
	if (typeof actual === "object" && actual !== null && typeof expected === "object" && expected !== null) {
		const left = actual as Record<string, unknown>;
		const right = expected as Record<string, unknown>;
		return (
			isDeepStrictEqual(Object.keys(left).sort(), Object.keys(right).sort()) &&
			Object.keys(right).every((key) => equivalent(left[key], right[key], tolerance))
		);
	}
	return isDeepStrictEqual(actual, expected);
}

export function assertJson(before: unknown, after: unknown, assertions: JsonAssertion[]): AssertionResult[] {
	return assertions.map((assertion) => {
		const actual = atPath(after, assertion.path);
		const expected = assertion.unchanged ? atPath(before, assertion.path) : assertion.equals;
		return {
			assertion: `${assertion.path || "/"} ${assertion.unchanged ? "preserved" : assertion.absent ? "absent" : "equals"}`,
			passed: assertion.absent ? actual === undefined : equivalent(actual, expected, assertion.tolerance ?? 0),
			expected: assertion.absent ? "<absent>" : expected,
			actual: actual === undefined ? "<absent>" : actual,
		};
	});
}
