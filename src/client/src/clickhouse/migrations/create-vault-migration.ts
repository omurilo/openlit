import { OPENLIT_VAULT_TABLE_NAME } from "@/lib/platform/vault/table-details";
import { getOnClusterClause, getMergeTreeEngine } from "@/clickhouse/cluster-config";
import migrationHelper from "./migration-helper";

const MIGRATION_ID = "create-vault-table";

export default async function CreateVaultMigration(databaseConfigId?: string) {
	const onCluster = getOnClusterClause();
	const engine = getMergeTreeEngine();

	const queries = [
		`
      CREATE TABLE IF NOT EXISTS ${OPENLIT_VAULT_TABLE_NAME} ${onCluster} (
        id UUID DEFAULT generateUUIDv4(),  -- Unique ID for each prompt
        key String,                  -- Name of the secret
        value String DEFAULT '',                 -- Value for the secret key
        created_by String,                 -- Who created the prompt
        created_at DateTime DEFAULT now(), -- Timestamp for when the secret was created
        updated_by String,                                   -- Who updated the version
        updated_at DateTime DEFAULT now(),                   -- When the version was updated
        tags String DEFAULT '[]',                              -- Tags for the version
        PRIMARY KEY id,                  -- Unique primary key constraint
      ) ENGINE = ${engine}
      ORDER BY id;
    `,
	];

	return migrationHelper({
		clickhouseMigrationId: MIGRATION_ID,
		databaseConfigId,
		queries,
	});
}
