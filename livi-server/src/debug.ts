/** Server-only diagnostics. Callers supply summaries, never raw model or room payloads. */
export function createDebugLogger(enabled: boolean, write: (line: string) => void = console.error) {
	if (!enabled) return undefined;
	return (event: string, fields: Record<string, unknown>) => {
		if (["connection.accepted", "connection.closed", "context.ready"].includes(event)) return;
		try {
			const safe = JSON.parse(
				JSON.stringify(fields, (key, value: unknown) =>
					value instanceof Error ||
					/api.?key|authorization|headers|password|secret|token|thinking|signature|snapshot|geometry|payload|^prompt$|^error$|connectionString|databaseUrl|catalogDatabase/i.test(
						key,
					)
						? "[redacted]"
						: value,
				),
			) as Record<string, unknown>;
			const details = Object.entries(safe)
				.filter(
					([key, value]) =>
						!/^(sessionId|operationId|turnId|invocationId|commandId|connectionId|requestId|messageLength|toolName)$/.test(
							key,
						) &&
						!(key === "mutationBlocked" && value === false) &&
						!(key === "arguments" && JSON.stringify(value) === "{}"),
				)
				.map(
					([key, value]) =>
						`${key}=${typeof value === "string" ? value.replace(/[\r\n\t]/g, " ") : JSON.stringify(value)}`,
				);
			const time = new Date().toTimeString().slice(0, 8);
			write([`[${time}]`, event.replace(/[._]/g, " "), safe.toolName, ...details].filter(Boolean).join(" "));
		} catch {
			// Diagnostics must never change chat or tool behavior.
		}
	};
}
