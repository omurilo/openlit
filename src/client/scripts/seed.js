/**
 * Seed script for ClickHouse system tables.
 *
 * Creates the default user, organisation, org membership, and DB config
 * using the same INIT_DB_* environment variables that the application uses.
 *
 * Run with: node scripts/seed.js
 */
const { createClient } = require("@clickhouse/client");
const { randomUUID } = require("crypto");

/** Format a Date/ISO string to ClickHouse DateTime compatible format */
function chDate(d) {
	return (d instanceof Date ? d : new Date(d))
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d{3}Z$/, "");
}

function getClient() {
	const host = process.env.INIT_DB_HOST;
	const port = process.env.INIT_DB_PORT || "8123";
	const database = process.env.INIT_DB_DATABASE || "openlit";
	const username = process.env.INIT_DB_USERNAME || "default";
	const password = process.env.INIT_DB_PASSWORD || "";

	if (!host) {
		throw new Error("INIT_DB_HOST is required");
	}

	const protocol = port === "443" ? "https" : "http";
	const url = `${protocol}://${host}:${port}`;

	return createClient({
		url,
		database,
		username,
		password,
		clickhouse_settings: { wait_end_of_query: 1, date_time_input_format: "best_effort" },
	});
}

async function queryFirst(client, query, params) {
	const result = await client.query({
		query,
		format: "JSONEachRow",
		query_params: params,
	});
	const rows = await result.json();
	return rows.length > 0 ? rows[0] : null;
}

async function insert(client, table, values) {
	await client.insert({ table, values, format: "JSONEachRow" });
}

async function main() {
	console.log("Seeding Start.....");
	const client = getClient();

	try {
		// Default password: "openlituser"
		const hashedPassword =
			"$2a$10$gh6Odw7fhLRrE1A1OxaHfeWOWKiZEEQpkOAhhCQ.RHx8VWOngwlHO";
		const now = chDate(new Date());

		// ----- 1. Upsert default user -----
		let user = await queryFirst(
			client,
			`SELECT id, has_completed_onboarding FROM openlit_users WHERE email = {email:String} LIMIT 1`,
			{ email: "user@openlit.io" }
		);

		if (user) {
			// Ensure onboarding is complete
			if (!user.has_completed_onboarding) {
				await client.exec({
					query: `ALTER TABLE openlit_users UPDATE has_completed_onboarding = 1, updated_at = now64(3) WHERE id = '${user.id}'`,
				});
			}
		} else {
			user = { id: randomUUID() };
			await insert(client, "openlit_users", [
				{
					id: user.id,
					email: "user@openlit.io",
					password: hashedPassword,
					name: "User",
					has_completed_onboarding: 1,
					created_at: now,
					updated_at: now,
				},
			]);
		}

		// ----- 2. Upsert default organisation -----
		let org = await queryFirst(
			client,
			`SELECT id FROM openlit_organisations WHERE slug = {slug:String} LIMIT 1`,
			{ slug: "default" }
		);

		if (!org) {
			org = { id: randomUUID() };
			await insert(client, "openlit_organisations", [
				{
					id: org.id,
					name: "Default Organisation",
					slug: "default",
					created_by_user_id: user.id,
					created_at: now,
					updated_at: now,
				},
			]);
		}

		// ----- 3. Link user to default organisation -----
		const membership = await queryFirst(
			client,
			`SELECT id FROM openlit_organisation_users WHERE organisation_id = {orgId:String} AND user_id = {userId:String} LIMIT 1`,
			{ orgId: org.id, userId: user.id }
		);

		if (!membership) {
			await insert(client, "openlit_organisation_users", [
				{
					id: randomUUID(),
					organisation_id: org.id,
					user_id: user.id,
					role: "owner",
					is_current: 1,
					created_at: now,
					updated_at: now,
				},
			]);
		}

		// ----- 4. Create Default DB config from env -----
		const envDBConfig = {
			username: process.env.INIT_DB_USERNAME || "default",
			password: process.env.INIT_DB_PASSWORD || "",
			host: process.env.INIT_DB_HOST,
			port: process.env.INIT_DB_PORT,
			database: process.env.INIT_DB_DATABASE || "default",
		};

		if (envDBConfig.host && envDBConfig.port) {
			let dbConfig = await queryFirst(
				client,
				`SELECT id FROM openlit_database_configs WHERE name = {name:String} AND organisation_id = {orgId:String} LIMIT 1`,
				{ name: "Default DB", orgId: org.id }
			);

			if (!dbConfig) {
				dbConfig = { id: randomUUID() };
				await insert(client, "openlit_database_configs", [
					{
						id: dbConfig.id,
						name: "Default DB",
						environment: "production",
						username: envDBConfig.username,
						password: envDBConfig.password,
						host: envDBConfig.host,
						port: envDBConfig.port,
						database: envDBConfig.database,
						query: "",
						created_by_user_id: user.id,
						organisation_id: org.id,
						created_at: now,
						updated_at: now,
					},
				]);
			}

			// Link user ↔ db config
			const dbConfigUser = await queryFirst(
				client,
				`SELECT database_config_id FROM openlit_database_config_users WHERE database_config_id = {configId:String} AND user_id = {userId:String} LIMIT 1`,
				{ configId: dbConfig.id, userId: user.id }
			);

			if (!dbConfigUser) {
				await insert(client, "openlit_database_config_users", [
					{
						database_config_id: dbConfig.id,
						user_id: user.id,
						is_current: 1,
						can_edit: 1,
						can_delete: 1,
						can_share: 1,
						created_at: now,
						updated_at: now,
					},
				]);
			}
		}

		console.log("Seeding End.....");
	} finally {
		await client.close();
	}
}

main().catch((e) => {
	console.error("Seed failed:", e);
	process.exit(1);
});
