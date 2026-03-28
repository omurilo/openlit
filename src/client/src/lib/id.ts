import { randomUUID } from "crypto";

/**
 * Generate a unique ID for new records (replaces Prisma's @default(cuid())).
 * Uses UUID v4 which is safe for distributed systems.
 */
export function generateId(): string {
	return randomUUID();
}
