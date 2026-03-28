import { OPENLIT_EVALUATION_TYPE_DEFAULTS_TABLE_NAME } from "@/lib/platform/evaluation/table-details";
import { EVALUATION_TYPE_CONTEXTS } from "@/constants/evaluation-type-contexts";
import { getOnClusterClause, getMergeTreeEngine } from "@/clickhouse/cluster-config";
import migrationHelper from "./migration-helper";

const MIGRATION_ID = "create-evaluation-type-defaults-table-5";

// Derive migration values from the single source of truth (evaluation-type-contexts.ts)
const DEFAULT_PROMPTS: Array<[string, string]> = Object.entries(
	EVALUATION_TYPE_CONTEXTS
).map(([id, { content }]) => [id, content]);

export default async function CreateEvaluationTypeDefaultsMigration(
	databaseConfigId?: string
) {
	const onCluster = getOnClusterClause();
	const engine = getMergeTreeEngine();

	const createQuery = `
    CREATE TABLE IF NOT EXISTS ${OPENLIT_EVALUATION_TYPE_DEFAULTS_TABLE_NAME} ${onCluster} (
      id String,
      default_prompt String
    ) ENGINE = ${engine} ORDER BY id;
  `;

	const values = DEFAULT_PROMPTS.map(([id, prompt]) => ({
		id,
		default_prompt: prompt,
	}));

	return migrationHelper({
		clickhouseMigrationId: MIGRATION_ID,
		databaseConfigId,
		queries: [
			createQuery,
			{ type: "insert", table: OPENLIT_EVALUATION_TYPE_DEFAULTS_TABLE_NAME, values },
		],
	});
}
