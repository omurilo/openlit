import { dataCollector } from "@/lib/platform/common";
import getMessage from "@/constants/messages";
import {
	systemQueryFirst,
	systemInsert,
} from "@/lib/system-db";
import { generateId } from "@/lib/id";
import asaw from "@/utils/asaw";
import { getDBConfigByUser, getDBConfigById } from "@/lib/db-config";
import {
	OPENLIT_OPENGROUND_TABLE_NAME,
	OPENLIT_OPENGROUND_PROVIDERS_TABLE_NAME,
	OPENLIT_OPENGROUND_CONFIG_TABLE_NAME,
} from "@/lib/platform/openground/table-details";
import { getOnClusterClause, getMergeTreeEngine } from "@/clickhouse/cluster-config";

export default async function CreateOpengroundMigration(databaseConfigId?: string) {
	const [, dbConfig] = await asaw(
		databaseConfigId
			? getDBConfigById({ id: databaseConfigId })
			: getDBConfigByUser(true)
	);

	if (!dbConfig?.id) return { err: getMessage().DATABASE_CONFIG_NOT_FOUND };

	// Check if migration already ran
	const migrationExist = await systemQueryFirst<{ id: string }>(
		`SELECT id FROM openlit_clickhouse_migrations WHERE database_config_id = {configId:String} AND clickhouse_migration_id = {migId:String} LIMIT 1`,
		{ configId: dbConfig.id, migId: "create-openground-table" }
	);

	if (migrationExist?.id) {
		return { migrationExist: true };
	}

	const onCluster = getOnClusterClause();
	const engine = getMergeTreeEngine();

	const opengroundTableQuery = `
		CREATE TABLE IF NOT EXISTS ${OPENLIT_OPENGROUND_TABLE_NAME} ${onCluster} (
			id UUID DEFAULT generateUUIDv4(),
			prompt String,
			prompt_source String DEFAULT 'custom',
			prompt_hub_id Nullable(UUID),
			prompt_hub_version Nullable(String),
			prompt_variables String DEFAULT '{}',
			created_by_user_id String,
			database_config_id String,
			created_at DateTime DEFAULT now(),
			total_providers UInt8,
			min_cost Float64,
			min_cost_provider String DEFAULT '',
			min_response_time Float64,
			min_response_time_provider String DEFAULT '',
			min_completion_tokens UInt32,
			min_completion_tokens_provider String DEFAULT '',
			errors Array(String),
			INDEX user_index (created_by_user_id) TYPE bloom_filter GRANULARITY 1,
			INDEX id_index (id) TYPE bloom_filter GRANULARITY 1,
			INDEX created_at_index (created_at) TYPE minmax GRANULARITY 1,
			INDEX prompt_source_index (prompt_source) TYPE bloom_filter GRANULARITY 1
		) ENGINE = ${engine}
		ORDER BY (database_config_id, created_at, created_by_user_id);
	`;

	const providerResultsQuery = `
		CREATE TABLE IF NOT EXISTS ${OPENLIT_OPENGROUND_PROVIDERS_TABLE_NAME} ${onCluster} (
			id UUID DEFAULT generateUUIDv4(),
			openground_id UUID,
			provider String,
			model String,
			config String DEFAULT '{}',
			response String DEFAULT '',
			error String DEFAULT '',
			cost Float64 DEFAULT 0,
			prompt_tokens UInt32 DEFAULT 0,
			completion_tokens UInt32 DEFAULT 0,
			total_tokens UInt32 DEFAULT 0,
			response_time Float64 DEFAULT 0,
			finish_reason String DEFAULT '',
			provider_response String DEFAULT '{}',
			created_at DateTime DEFAULT now(),
			INDEX id_index (id) TYPE bloom_filter GRANULARITY 1,
			INDEX provider_index (provider) TYPE bloom_filter GRANULARITY 1,
			INDEX model_index (model) TYPE bloom_filter GRANULARITY 1
		) ENGINE = ${engine}
		ORDER BY (openground_id, provider, created_at);
	`;

	const configTableQuery = `
		CREATE TABLE IF NOT EXISTS ${OPENLIT_OPENGROUND_CONFIG_TABLE_NAME} ${onCluster} (
			id UUID DEFAULT generateUUIDv4(),
			user_id String,
			database_config_id String,
			provider String,
			vault_id String,
			model_id Nullable(String),
			is_active Boolean DEFAULT true,
			created_at DateTime DEFAULT now(),
			updated_at DateTime DEFAULT now(),
			INDEX id_index (id) TYPE bloom_filter GRANULARITY 1,
			INDEX provider_index (provider) TYPE bloom_filter GRANULARITY 1,
			INDEX active_index (is_active) TYPE bloom_filter GRANULARITY 1
		) ENGINE = ${engine}
		ORDER BY (user_id, database_config_id, provider);
	`;

	const queries = [opengroundTableQuery, providerResultsQuery, configTableQuery];

	const queryResponses = await Promise.all(
		queries.map(async (query) => await dataCollector({ query }, "exec", dbConfig.id))
	);

	const errors = queryResponses.filter((res) => res.err);
	if (errors.length > 0) {
		console.error("Migration errors:", errors);
		return { err: getMessage().OPENGROUND_MIGRATION_FAILED };
	}

	// Record migration success
	await systemInsert("openlit_clickhouse_migrations", [
		{
			id: generateId(),
			database_config_id: dbConfig.id,
			clickhouse_migration_id: "create-openground-table",
		},
	]);

	return { data: "Openground migration successful" };
}
