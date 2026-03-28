import crypto from "crypto";
import { getDBConfigByUser } from "@/lib/db-config";
import asaw from "@/utils/asaw";
import {
	systemQuery,
	systemQueryFirst,
	systemInsert,
	systemExec,
} from "@/lib/system-db";
import { getCurrentUser } from "@/lib/session";
import { throwIfError } from "@/utils/error";
import getMessage from "@/constants/messages";
import { generateId } from "@/lib/id";
import { DatabaseConfig } from "@/lib/models";

const APIKEY_PREFIX = "openlit-";

function createAPIKey() {
	const key = crypto.randomBytes(32);
	return `${APIKEY_PREFIX}${key.toString("base64")}`;
}

export async function generateAPIKey(name: string) {
	const user = await getCurrentUser();
	throwIfError(!user, getMessage().UNAUTHORIZED_USER);

	const [err, dbConfig] = await asaw(getDBConfigByUser(true));
	throwIfError(err, err);
	throwIfError(!dbConfig?.id, getMessage().DATABASE_CONFIG_NOT_FOUND);

	const apiKey = createAPIKey();
	const id = generateId();

	await systemInsert("openlit_api_keys", [
		{
			id,
			api_key: apiKey,
			name,
			database_config_id: (dbConfig as DatabaseConfig).id,
			created_by_user_id: user!.id,
			is_deleted: 0,
			created_at: new Date().toISOString(),
			deleted_at: null,
			deleted_by_user_id: null,
		},
	]);

	return {
		apiKey,
		databaseConfigId: (dbConfig as DatabaseConfig).id,
	};
}

export async function getAPIKeyInfo({ apiKey }: { apiKey: string }): Promise<[string | null, { id: string; name: string; apiKey: string; databaseConfigId: string; isDeleted: boolean; createdAt: Date; createdByUserId: string } | null]> {
	const row = await systemQueryFirst<{
		id: string;
		name: string;
		api_key: string;
		database_config_id: string;
		is_deleted: number;
		created_at: string;
		created_by_user_id: string;
	}>(
		`SELECT * FROM openlit_api_keys WHERE api_key = {apiKey:String} AND is_deleted = 0 LIMIT 1`,
		{ apiKey }
	);
	if (!row) return [null, null];
	return [
		null,
		{
			id: row.id,
			name: row.name,
			apiKey: row.api_key,
			databaseConfigId: row.database_config_id,
			isDeleted: !!row.is_deleted,
			createdAt: new Date(row.created_at),
			createdByUserId: row.created_by_user_id,
		},
	];
}

export async function getAllAPIKeys() {
	const [err, dbConfig] = await asaw(getDBConfigByUser(true));
	throwIfError(err, err);
	throwIfError(!dbConfig?.id, getMessage().DATABASE_CONFIG_NOT_FOUND);

	const rows = await systemQuery<{
		id: string;
		name: string;
		api_key: string;
		created_at: string;
		created_by_user_id: string;
		created_by_email: string;
	}>(
		`SELECT ak.id, ak.name, ak.api_key, ak.created_at, ak.created_by_user_id, u.email AS created_by_email
		FROM openlit_api_keys ak
		INNER JOIN openlit_users u ON u.id = ak.created_by_user_id
		WHERE ak.database_config_id = {configId:String} AND ak.is_deleted = 0
		ORDER BY ak.created_at DESC`,
		{ configId: (dbConfig as DatabaseConfig).id }
	);

	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		apiKey: r.api_key,
		createdAt: new Date(r.created_at),
		createdByUser: { email: r.created_by_email },
	}));
}

export async function deleteAPIKey(id: string) {
	await systemExec(
		`ALTER TABLE openlit_api_keys UPDATE is_deleted = 1, deleted_at = now64(3) WHERE id = '${id}'`
	);
	return [null, { success: true }];
}
