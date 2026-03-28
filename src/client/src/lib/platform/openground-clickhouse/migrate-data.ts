/**
 * OpenGround data migration – SQLite/Prisma → ClickHouse.
 *
 * With the removal of SQLite, there is no longer a source database to migrate
 * from. These functions are kept as no-ops so that existing API routes and
 * callers continue to compile without changes.
 */

/**
 * @deprecated No-op: SQLite/Prisma has been removed. Data is now created
 * directly in ClickHouse.
 */
export async function migrateOpengroundDataToClickhouse(
	_databaseConfigId: string
) {
	return { data: "No migration needed – SQLite has been removed." };
}

/**
 * @deprecated Always returns false because there is no Prisma source to
 * migrate from.
 */
export async function checkMigrationNeeded(
	_databaseConfigId: string
): Promise<boolean> {
	return false;
}
