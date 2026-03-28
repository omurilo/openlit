import getMessage from "@/constants/messages";
import { getDBConfigById, getDBConfigByUser } from "@/lib/db-config";
import { dataCollector } from "@/lib/platform/common";
import {
	systemQueryFirst,
	systemInsert,
} from "@/lib/system-db";
import { generateId } from "@/lib/id";
import asaw from "@/utils/asaw";
import { consoleLog } from "@/utils/log";

type MigrationQuery =
	| string
	| { type: "insert"; table: string; values: Record<string, unknown>[] };

export default async function migrationHelper({
	clickhouseMigrationId,
	queries,
	databaseConfigId,
}: {
	clickhouseMigrationId: string;
	queries: MigrationQuery[];
	databaseConfigId?: string;
}) {
	let err, dbConfig;
	if (databaseConfigId) {
		[err, dbConfig] = await asaw(getDBConfigById({ id: databaseConfigId }));
	} else {
		[err, dbConfig] = await asaw(getDBConfigByUser(true));
	}

	if (err || !dbConfig?.id) throw err || getMessage().DATABASE_CONFIG_NOT_FOUND;

	const migrationExist = await systemQueryFirst<{
		id: string;
		database_config_id: string;
		clickhouse_migration_id: string;
	}>(
		`SELECT * FROM openlit_clickhouse_migrations WHERE database_config_id = {configId:String} AND clickhouse_migration_id = {migrationId:String} LIMIT 1`,
		{
			configId: dbConfig.id as string,
			migrationId: clickhouseMigrationId,
		}
	);

	if (migrationExist?.id) {
		return { migrationExist: true, queriesRun: false };
	}

	const queriesRun = await Promise.all(
		queries.map(async (query) => {
			if (typeof query === "string") {
				const { err } = await dataCollector(
					{ query },
					"exec",
					dbConfig.id
				);
				if (err) {
					console.log(
						`********* Migration Error : ${clickhouseMigrationId} *********`
					);
					consoleLog(err);
					console.log(
						`********* Migration Error : ${clickhouseMigrationId} *********`
					);
				}
				return { err };
			}
			if (query.type === "insert") {
				const { err } = await dataCollector(
					{
						table: query.table,
						values: query.values,
					},
					"insert",
					dbConfig.id
				);
				if (err) {
					console.log(
						`********* Migration Error : ${clickhouseMigrationId} (insert) *********`
					);
					consoleLog(err);
				}
				return { err };
			}
			return { err: new Error("Unknown query type") };
		})
	);

	if (queriesRun.filter(({ err }) => !err).length === queries.length) {
		await asaw(
			systemInsert("openlit_clickhouse_migrations", [
				{
					id: generateId(),
					database_config_id: dbConfig.id,
					clickhouse_migration_id: clickhouseMigrationId,
				},
			])
		);

		return { migrationExist: false, queriesRun: true };
	}

	return { migrationExist: false, queriesRun: false };
}
