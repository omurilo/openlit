import { dataCollector } from "@/lib/platform/common";
import getMessage from "@/constants/messages";
import {
	systemQueryFirst,
	systemInsert,
} from "@/lib/system-db";
import { generateId } from "@/lib/id";
import asaw from "@/utils/asaw";
import { getDBConfigById, getDBConfigByUser } from "@/lib/db-config";
import { getOnClusterClause, getMergeTreeEngine } from "@/clickhouse/cluster-config";

export const OPENLIT_OPENGROUND_CUSTOM_MODELS_TABLE_NAME = "openlit_openground_custom_models";

export default async function CreateOpengroundCustomModelsMigration(databaseConfigId?: string) {
	const [, dbConfig] = await asaw(
		databaseConfigId
			? getDBConfigById({ id: databaseConfigId })
			: getDBConfigByUser(true)
	);

	if (!dbConfig?.id) return { err: getMessage().DATABASE_CONFIG_NOT_FOUND };

	// Check if migration already ran
	const migrationExist = await systemQueryFirst<{ id: string }>(
		`SELECT id FROM openlit_clickhouse_migrations WHERE database_config_id = {configId:String} AND clickhouse_migration_id = {migId:String} LIMIT 1`,
		{ configId: dbConfig.id, migId: "create-openground-custom-models-table" }
	);

	if (migrationExist?.id) {
		return { migrationExist: true };
	}

	const onCluster = getOnClusterClause();
	const engine = getMergeTreeEngine();

	const customModelsTableQuery = `
		CREATE TABLE IF NOT EXISTS ${OPENLIT_OPENGROUND_CUSTOM_MODELS_TABLE_NAME} ${onCluster} (
			id UUID DEFAULT generateUUIDv4(),
			provider String,
			model_id String,
			display_name String,
			context_window UInt32 DEFAULT 4096,
			input_price_per_m_token Float64 DEFAULT 0,
			output_price_per_m_token Float64 DEFAULT 0,
			capabilities Array(String) DEFAULT [],
			created_by_user_id String,
			database_config_id String,
			created_at DateTime DEFAULT now(),
			updated_at DateTime DEFAULT now()
		) ENGINE = ${engine}
		PRIMARY KEY (database_config_id, created_by_user_id, provider, id)
		ORDER BY (database_config_id, created_by_user_id, provider, id, created_at);
	`;

	const { err } = await dataCollector(
		{ query: customModelsTableQuery },
		"exec",
		dbConfig.id
	);

	if (err) {
		console.error("Migration error:", err);
		return { err: getMessage().OPERATION_FAILED };
	}

	// Record migration success
	await systemInsert("openlit_clickhouse_migrations", [
		{
			id: generateId(),
			database_config_id: dbConfig.id,
			clickhouse_migration_id: "create-openground-custom-models-table",
		},
	]);

	return { data: "Migration successful" };
}
