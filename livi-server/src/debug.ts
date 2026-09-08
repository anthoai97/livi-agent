/** Server-only diagnostics. Callers supply summaries, never raw model or room payloads. */
export function createDebugLogger(enabled: boolean, write: (line: string) => void = console.error) {
	if (!enabled) return undefined;
	return (event: string, fields: Record<string, unknown>) => {
		try {
			write(
				JSON.stringify({ ...fields, timestamp: new Date().toISOString(), event }, (key, value: unknown) =>
					value instanceof Error ||
					/api.?key|authorization|headers|password|secret|token|thinking|signature|snapshot|geometry|payload|^prompt$|^error$/i.test(
						key,
					)
						? "[redacted]"
						: value,
				),
			);
		} catch {
			// Diagnostics must never change chat or tool behavior.
		}
	};
}
