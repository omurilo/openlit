/**
 * Backward-compatible re-export of the system ClickHouse helpers.
 *
 * All code that used to do `import prisma from "@/lib/prisma"` can now
 * import from here (or directly from "@/lib/system-db") without breaking.
 *
 * This file is intentionally kept so that existing import paths continue to
 * work during the migration away from Prisma/SQLite.
 */
export {
	systemQuery,
	systemQueryFirst,
	systemExec,
	systemInsert,
	systemCommand,
} from "./system-db";
