import { Pool } from "pg";

export const connectionString = process.env.TEST_SESSION_DATABASE_URL!;
if (!connectionString)
	throw new Error("TEST_SESSION_DATABASE_URL must name a disposable PostgreSQL database; tests destroy livi_sessions");
export async function resetDatabase(): Promise<void> {
	const pool = new Pool({ connectionString, max: 1 });
	try {
		await pool.query("DROP SCHEMA IF EXISTS livi_sessions CASCADE");
	} finally {
		await pool.end();
	}
}
