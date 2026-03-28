/**
 * System-level ClickHouse client for application state (users, orgs, configs).
 *
 * Replaces SQLite/Prisma with a direct ClickHouse connection using the
 * INIT_DB_* environment variables. This single client is used for all
 * "system" tables (auth, users, organisations, db-configs, api-keys, etc.)
 * and is completely separate from the per-tenant ClickHouse pools used for
 * observability data.
 */
import { createClient, ClickHouseClient } from "@clickhouse/client";

let systemClient: ClickHouseClient | undefined;

function getSystemClient(): ClickHouseClient {
	if (systemClient) return systemClient;

	const host = process.env.INIT_DB_HOST;
	const port = process.env.INIT_DB_PORT || "8123";
	const database = process.env.INIT_DB_DATABASE || "openlit";
	const username = process.env.INIT_DB_USERNAME || "default";
	const password = process.env.INIT_DB_PASSWORD || "";

	if (!host) {
		throw new Error(
			"INIT_DB_HOST is required for the system ClickHouse connection"
		);
	}

	const protocol = port === "443" ? "https" : "http";
	const url = `${protocol}://${host}:${port}`;

	systemClient = createClient({
		url,
		database,
		username,
		password,
		clickhouse_settings: {
			wait_end_of_query: 1,
			date_time_input_format: "best_effort",
		},
	});

	return systemClient;
}

// ------------------------------------------------------------------
// Generic helpers
// ------------------------------------------------------------------

export async function systemQuery<T = Record<string, unknown>>(
	query: string,
	params?: Record<string, unknown>
): Promise<T[]> {
	const client = getSystemClient();
	const result = await client.query({
		query,
		format: "JSONEachRow",
		query_params: params,
	});
	return (await result.json()) as T[];
}

export async function systemExec(query: string): Promise<void> {
	const client = getSystemClient();
	await client.exec({ query });
}

/** Convert ISO 8601 strings to ClickHouse DateTime format in-place */
function sanitizeDates(obj: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
			result[key] = value.replace("T", " ").replace(/\.\d{3}Z$/, "");
		} else {
			result[key] = value;
		}
	}
	return result;
}

export async function systemInsert<T extends Record<string, unknown>>(
	table: string,
	values: T[]
): Promise<void> {
	const client = getSystemClient();
	await client.insert({
		table,
		values: values.map(sanitizeDates),
		format: "JSONEachRow",
	});
}

export async function systemCommand(query: string): Promise<void> {
	const client = getSystemClient();
	await client.command({ query });
}

/**
 * Return the first row or null for convenience.
 */
export async function systemQueryFirst<T = Record<string, unknown>>(
	query: string,
	params?: Record<string, unknown>
): Promise<T | null> {
	const rows = await systemQuery<T>(query, params);
	return rows.length > 0 ? rows[0] : null;
}

export default getSystemClient;
