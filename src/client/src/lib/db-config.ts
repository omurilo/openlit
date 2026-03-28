import asaw from "@/utils/asaw";
import {
	systemQuery,
	systemQueryFirst,
	systemInsert,
	systemExec,
} from "./system-db";
import { getCurrentUser } from "./session";
import { DatabaseConfig, DatabaseConfigInvitedUser } from "@/lib/models";
import migrations from "@/clickhouse/migrations";
import getMessage from "@/constants/messages";
import { throwIfError } from "@/utils/error";
import { consoleLog } from "@/utils/log";
import { getCurrentOrganisation } from "./organisation";
import { generateId } from "@/lib/id";

// ---- Row types ------------------------------------------------------------

interface DBConfigRow {
	id: string;
	name: string;
	environment: string;
	username: string;
	password: string | null;
	host: string;
	port: string;
	database: string;
	query: string | null;
	created_at: string;
	updated_at: string;
	user_id: string;
	organisation_id: string | null;
}

interface DBConfigUserRow {
	database_config_id: string;
	user_id: string;
	is_current: number;
	can_edit: number;
	can_share: number;
	can_delete: number;
	created_at: string;
	updated_at: string;
}

function rowToDBConfig(r: DBConfigRow): DatabaseConfig {
	return {
		id: r.id,
		name: r.name,
		environment: r.environment,
		username: r.username,
		password: r.password,
		host: r.host,
		port: r.port,
		database: r.database,
		query: r.query,
		createdAt: new Date(r.created_at),
		updatedAt: new Date(r.updated_at),
		createdByUserId: r.user_id,
		organisationId: r.organisation_id,
	};
}

// ---- Public API -----------------------------------------------------------

export const getDBConfigByUser = async (currentOnly?: boolean) => {
	const user = await getCurrentUser();
	if (!user) throw new Error(getMessage().UNAUTHORIZED_USER);

	const currentOrg = await getCurrentOrganisation();

	// Auto-migrate orphaned configs
	if (currentOrg?.id) {
		const orphanedLinks = await systemQuery<{ database_config_id: string }>(
			`SELECT dcu.database_config_id
			FROM openlit_database_config_users dcu
			INNER JOIN openlit_database_configs dc ON dc.id = dcu.database_config_id
			WHERE dcu.user_id = {userId:String} AND (dc.organisation_id IS NULL OR dc.organisation_id = '')`,
			{ userId: user.id }
		);

		if (orphanedLinks.length > 0) {
			const ids = orphanedLinks.map((l) => `'${l.database_config_id}'`).join(",");
			await systemExec(
				`ALTER TABLE openlit_database_configs UPDATE organisation_id = '${currentOrg.id}', updated_at = now64(3) WHERE id IN (${ids})`
			);
			consoleLog(
				`Auto-migrated ${orphanedLinks.length} orphaned configs for user ${user.id} to org ${currentOrg.id}`
			);
		}
	}

	const orgFilter = currentOrg?.id
		? `dc.organisation_id = '${currentOrg.id}'`
		: `(dc.organisation_id IS NULL OR dc.organisation_id = '')`;

	if (currentOnly) {
		const row = await systemQueryFirst<DBConfigRow>(
			`SELECT dc.*
			FROM openlit_database_config_users dcu
			INNER JOIN openlit_database_configs dc ON dc.id = dcu.database_config_id
			WHERE dcu.user_id = {userId:String} AND dcu.is_current = 1 AND ${orgFilter}
			LIMIT 1`,
			{ userId: user.id }
		);
		return row ? rowToDBConfig(row) : undefined;
	}

	const rows = await systemQuery<DBConfigRow & { is_current: number; can_edit: number; can_delete: number; can_share: number }>(
		`SELECT dc.*, dcu.is_current, dcu.can_edit, dcu.can_delete, dcu.can_share
		FROM openlit_database_config_users dcu
		INNER JOIN openlit_database_configs dc ON dc.id = dcu.database_config_id
		WHERE dcu.user_id = {userId:String} AND ${orgFilter}
		ORDER BY dc.created_at ASC`,
		{ userId: user.id }
	);

	return rows.map((r) => ({
		...rowToDBConfig(r),
		isCurrent: !!r.is_current,
		permissions: {
			canEdit: !!r.can_edit,
			canDelete: !!r.can_delete,
			canShare: !!r.can_share,
		},
	}));
};

export const getDBConfigById = async ({ id }: { id: string }) => {
	const row = await systemQueryFirst<DBConfigRow>(
		`SELECT * FROM openlit_database_configs WHERE id = {id:String} LIMIT 1`,
		{ id }
	);
	return row ? rowToDBConfig(row) : null;
};

export const upsertDBConfig = async (
	dbConfig: Partial<DatabaseConfig>,
	id?: string
) => {
	if (!dbConfig.name) throw new Error("No name provided");
	if (!dbConfig.username) throw new Error("No username provided");
	if (!dbConfig.host) throw new Error("No host provided");
	if (!dbConfig.port) throw new Error("No port provided");
	if (!dbConfig.database) throw new Error("No database provided");

	const user = await getCurrentUser();
	throwIfError(!user, getMessage().UNAUTHORIZED_USER);

	const currentOrg = await getCurrentOrganisation();

	// Check for name collision
	const orgFilter = currentOrg?.id
		? `organisation_id = '${currentOrg.id}'`
		: `(organisation_id IS NULL OR organisation_id = '')`;
	const nameCheck = await systemQueryFirst<{ id: string }>(
		`SELECT id FROM openlit_database_configs WHERE name = {name:String} AND ${orgFilter} ${id ? `AND id != '${id}'` : ""} LIMIT 1`,
		{ name: dbConfig.name }
	);
	if (nameCheck?.id) throw new Error("DB config Name already exists");

	if (id) {
		await checkPermissionForDbAction(user!.id, id, "EDIT");
	}

	const now = new Date().toISOString();
	let resultId: string;

	if (id) {
		// Update existing config
		const sets: string[] = [];
		if (dbConfig.name) sets.push(`name = '${dbConfig.name.replace(/'/g, "\\'")}'`);
		if (dbConfig.environment) sets.push(`environment = '${dbConfig.environment}'`);
		if (dbConfig.username) sets.push(`username = '${dbConfig.username}'`);
		if (dbConfig.password !== undefined) sets.push(`password = '${(dbConfig.password || "").replace(/'/g, "\\'")}'`);
		if (dbConfig.host) sets.push(`host = '${dbConfig.host}'`);
		if (dbConfig.port) sets.push(`port = '${dbConfig.port}'`);
		if (dbConfig.database) sets.push(`\`database\` = '${dbConfig.database}'`);
		if (dbConfig.query !== undefined) sets.push(`query = '${(dbConfig.query || "").replace(/'/g, "\\'")}'`);
		sets.push(`updated_at = '${now}'`);

		await systemExec(
			`ALTER TABLE openlit_database_configs UPDATE ${sets.join(", ")} WHERE id = '${id}'`
		);
		resultId = id;
	} else {
		// Create new config
		resultId = generateId();
		await systemInsert("openlit_database_configs", [
			{
				id: resultId,
				name: dbConfig.name,
				environment: dbConfig.environment || "production",
				username: dbConfig.username,
				password: dbConfig.password || "",
				host: dbConfig.host,
				port: dbConfig.port,
				database: dbConfig.database,
				query: dbConfig.query || "",
				user_id: user!.id,
				organisation_id: currentOrg?.id || "",
				created_at: now,
				updated_at: now,
			},
		]);

		await addDatabaseConfigUserEntry(user!.id, resultId, {
			canEdit: true,
			canDelete: true,
			canShare: true,
		});

		migrations(resultId);
	}

	return `${id ? "Updated" : "Added"} db details successfully`;
};

export async function deleteDBConfig(id: string) {
	const user = await getCurrentUser();
	if (!user) throw new Error(getMessage().UNAUTHORIZED_USER);

	await checkPermissionForDbAction(user.id, id, "DELETE");

	await systemExec(
		`ALTER TABLE openlit_database_config_users DELETE WHERE database_config_id = '${id}' AND user_id = '${user.id}'`
	);
	await systemExec(
		`ALTER TABLE openlit_database_configs DELETE WHERE id = '${id}'`
	);

	return "Deleted successfully!";
}

export async function setCurrentDBConfig(id: string) {
	const user = await getCurrentUser();
	if (!user) throw new Error(getMessage().UNAUTHORIZED_USER);

	const currentConfig = await getDBConfigByUser(true);

	if ((currentConfig as DatabaseConfig)?.id) {
		await systemExec(
			`ALTER TABLE openlit_database_config_users UPDATE is_current = 0 WHERE database_config_id = '${(currentConfig as DatabaseConfig).id}' AND user_id = '${user.id}'`
		);
	}

	await systemExec(
		`ALTER TABLE openlit_database_config_users UPDATE is_current = 1 WHERE database_config_id = '${id}' AND user_id = '${user.id}'`
	);

	return "Current DB config set successfully!";
}

export async function shareDBConfig({
	shareArray,
	id,
}: {
	id: string;
	shareArray: {
		email: string;
		permissions?: {
			canDelete: boolean;
			canEdit: boolean;
			canShare: boolean;
		};
	}[];
}) {
	if (!id || !shareArray?.length) throw new Error("No user to share!");

	const user = await getCurrentUser();
	if (!user) throw new Error(getMessage().UNAUTHORIZED_USER);

	const { dbUserConfig } = await checkPermissionForDbAction(user.id, id, "SHARE");

	return await Promise.all(
		shareArray.map(
			async ({
				email,
				permissions = { canDelete: false, canEdit: false, canShare: false },
			}) => {
				const normalizedEmail = email.toLowerCase().trim();

				const existingUser = await systemQueryFirst<{ id: string }>(
					`SELECT id FROM openlit_users WHERE email = {email:String} LIMIT 1`,
					{ email: normalizedEmail }
				);

				if (existingUser) {
					const dbConfigUser = await systemQueryFirst<DBConfigUserRow>(
						`SELECT * FROM openlit_database_config_users WHERE user_id = {userId:String} AND database_config_id = {configId:String} LIMIT 1`,
						{ userId: existingUser.id, configId: id }
					);

					if (!dbConfigUser) {
						await addDatabaseConfigUserEntry(existingUser.id, id, permissions);
						return [, { success: true }];
					}

					return [`Already shared to ${normalizedEmail}`, { success: false }];
				} else {
					const [createErr] = await asaw(
						systemInsert("openlit_database_config_invited_users", [
							{
								database_config_id: id,
								email: normalizedEmail,
								can_edit: (!!dbUserConfig.can_edit && permissions.canEdit) ? 1 : 0,
								can_delete: (!!dbUserConfig.can_delete && permissions.canDelete) ? 1 : 0,
								can_share: (!!dbUserConfig.can_share && permissions.canShare) ? 1 : 0,
							},
						])
					);

					return [createErr, { success: !createErr }];
				}
			}
		)
	);
}

export async function moveSharedDBConfigToDBUser(
	email: string,
	userId: string
) {
	const [sharedConfigErr, sharedConfig] = await asaw(
		systemQuery<{ database_config_id: string; can_edit: number; can_share: number; can_delete: number }>(
			`SELECT * FROM openlit_database_config_invited_users WHERE email = {email:String}`,
			{ email }
		)
	);

	if (sharedConfigErr) {
		consoleLog(sharedConfigErr);
		return;
	}

	if (!sharedConfig?.length) return;

	for (const sc of sharedConfig) {
		await asaw(
			systemInsert("openlit_database_config_users", [
				{
					database_config_id: sc.database_config_id,
					user_id: userId,
					can_delete: sc.can_delete,
					can_edit: sc.can_edit,
					can_share: sc.can_share,
					is_current: 0,
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				},
			])
		);
	}

	// Set first config as current if user has no current config
	const hasCurrentConfig = await systemQueryFirst<DBConfigUserRow>(
		`SELECT * FROM openlit_database_config_users WHERE user_id = {userId:String} AND is_current = 1 LIMIT 1`,
		{ userId }
	);

	if (!hasCurrentConfig) {
		const firstConfig = await systemQueryFirst<DBConfigUserRow>(
			`SELECT * FROM openlit_database_config_users WHERE user_id = {userId:String} LIMIT 1`,
			{ userId }
		);
		if (firstConfig) {
			await systemExec(
				`ALTER TABLE openlit_database_config_users UPDATE is_current = 1 WHERE database_config_id = '${firstConfig.database_config_id}' AND user_id = '${userId}'`
			);
		}
	}
}

// ---- Internal helpers -----------------------------------------------------

async function addDatabaseConfigUserEntry(
	userId: string,
	databaseConfigId: string,
	permissions: {
		canDelete: boolean;
		canEdit: boolean;
		canShare: boolean;
	}
) {
	const dbConfig = await systemQueryFirst<{ organisation_id: string | null }>(
		`SELECT organisation_id FROM openlit_database_configs WHERE id = {id:String} LIMIT 1`,
		{ id: databaseConfigId }
	);

	const orgFilter = dbConfig?.organisation_id
		? `dc.organisation_id = '${dbConfig.organisation_id}'`
		: `(dc.organisation_id IS NULL OR dc.organisation_id = '')`;

	const existingCurrentConfigInOrg = await systemQueryFirst<DBConfigUserRow>(
		`SELECT dcu.*
		FROM openlit_database_config_users dcu
		INNER JOIN openlit_database_configs dc ON dc.id = dcu.database_config_id
		WHERE dcu.user_id = {userId:String} AND dcu.is_current = 1 AND ${orgFilter}
		LIMIT 1`,
		{ userId }
	);

	await systemInsert("openlit_database_config_users", [
		{
			user_id: userId,
			database_config_id: databaseConfigId,
			is_current: existingCurrentConfigInOrg ? 0 : 1,
			can_edit: permissions.canEdit ? 1 : 0,
			can_share: permissions.canShare ? 1 : 0,
			can_delete: permissions.canDelete ? 1 : 0,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		},
	]);
}

async function checkPermissionForDbAction(
	userId: string,
	databaseConfigId: string,
	actionType: "DELETE" | "SHARE" | "EDIT"
) {
	const dbUserConfig = await systemQueryFirst<DBConfigUserRow>(
		`SELECT * FROM openlit_database_config_users WHERE database_config_id = {configId:String} AND user_id = {userId:String} LIMIT 1`,
		{ configId: databaseConfigId, userId }
	);

	if (!dbUserConfig)
		throw new Error("Database config doesn't exist");

	switch (actionType) {
		case "DELETE":
			if (!dbUserConfig.can_delete)
				throw new Error(
					"User doesn't have permission to delete the database config"
				);
			break;
		case "EDIT":
			if (!dbUserConfig.can_edit)
				throw new Error(
					"User doesn't have permission to edit the database config"
				);
			break;
		case "SHARE":
			if (!dbUserConfig.can_share)
				throw new Error(
					"User doesn't have permission to share the database config"
				);
			break;
		default:
			break;
	}

	return {
		success: true,
		dbUserConfig,
	};
}
