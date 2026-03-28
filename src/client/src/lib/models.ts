/**
 * Application model types – replaces the auto-generated Prisma types.
 * 
 * These map 1:1 to the ClickHouse system tables defined in
 * assets/clickhouse-init.sh.
 */

export interface User {
	id: string;
	name: string | null;
	email: string;
	emailVerified: Date | null;
	password: string | null;
	image: string | null;
	hasCompletedOnboarding: boolean;
	createdAt: Date;
	updatedAt: Date;
}

export interface Account {
	id: string;
	userId: string;
	type: string | null;
	provider: string;
	providerAccountId: string;
	token_type: string | null;
	refresh_token: string | null;
	access_token: string | null;
	expires_at: number | null;
	scope: string | null;
	id_token: string | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface Session {
	id: string;
	userId: string | null;
	sessionToken: string;
	accessToken: string | null;
	expires: Date;
	createdAt: Date;
	updatedAt: Date;
}

export interface VerificationRequest {
	id: string;
	identifier: string;
	token: string;
	expires: Date;
	createdAt: Date;
	updatedAt: Date;
}

export interface Organisation {
	id: string;
	name: string;
	slug: string;
	createdAt: Date;
	updatedAt: Date;
	createdByUserId: string;
}

export interface OrganisationUser {
	id: string;
	organisationId: string;
	userId: string;
	role: string;
	isCurrent: boolean;
	createdAt: Date;
	updatedAt: Date;
}

export interface OrganisationInvitedUser {
	id: string;
	organisationId: string;
	email: string;
	invitedByUserId: string;
	createdAt: Date;
}

export interface DatabaseConfig {
	id: string;
	name: string;
	environment: string;
	username: string;
	password: string | null;
	host: string;
	port: string;
	database: string;
	query: string | null;
	createdAt: Date;
	updatedAt: Date;
	createdByUserId: string;
	organisationId: string | null;
}

export interface DatabaseConfigUser {
	databaseConfigId: string;
	userId: string;
	isCurrent: boolean;
	canEdit: boolean;
	canShare: boolean;
	canDelete: boolean;
	createdAt: Date;
	updatedAt: Date;
}

export interface DatabaseConfigInvitedUser {
	databaseConfigId: string;
	email: string;
	canEdit: boolean;
	canShare: boolean;
	canDelete: boolean;
}

export interface APIKey {
	id: string;
	name: string;
	apiKey: string;
	databaseConfigId: string;
	isDeleted: boolean;
	createdAt: Date;
	createdByUserId: string;
	deletedAt: Date | null;
	deletedByUserId: string | null;
}

export interface EvaluationConfig {
	id: string;
	databaseConfigId: string;
	provider: string;
	model: string;
	vaultId: string;
	auto: boolean;
	recurringTime: string;
	meta: string;
}

export interface ClickhouseMigration {
	id: string;
	databaseConfigId: string;
	clickhouseMigrationId: string;
}
