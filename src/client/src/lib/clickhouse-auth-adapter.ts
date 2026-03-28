/**
 * NextAuth adapter backed by ClickHouse system tables.
 *
 * Implements the NextAuth Adapter interface so that user/account/session/
 * verification-token data is stored in ClickHouse instead of SQLite.
 */
import type { Adapter, AdapterUser, AdapterAccount, AdapterSession } from "next-auth/adapters";
import {
	systemQuery,
	systemQueryFirst,
	systemInsert,
	systemExec,
} from "@/lib/system-db";
import { generateId } from "@/lib/id";

// ---- Row ↔ Domain mappers ------------------------------------------------

interface UserRow {
	id: string;
	name: string | null;
	email: string;
	email_verified: string | null;
	password: string | null;
	image: string | null;
	has_completed_onboarding: number;
	created_at: string;
	updated_at: string;
}

function rowToAdapterUser(r: UserRow): AdapterUser {
	return {
		id: r.id,
		name: r.name ?? null,
		email: r.email,
		emailVerified: r.email_verified ? new Date(r.email_verified) : null,
		image: r.image ?? null,
	} as AdapterUser;
}

interface SessionRow {
	id: string;
	user_id: string | null;
	session_token: string;
	expires: string;
}

function rowToSession(r: SessionRow): AdapterSession {
	return {
		sessionToken: r.session_token,
		userId: r.user_id ?? "",
		expires: new Date(r.expires),
	};
}

// ---- Adapter implementation -----------------------------------------------

export function ClickHouseAdapter(): Adapter {
	return {
		async createUser(user) {
			const id = generateId();
			const normalizedEmail = (user.email ?? "").toLowerCase().trim();
			const now = new Date().toISOString();

			await systemInsert("openlit_users", [
				{
					id,
					name: user.name ?? null,
					email: normalizedEmail,
					email_verified: user.emailVerified
						? user.emailVerified.toISOString()
						: null,
					password: null,
					image: user.image ?? null,
					has_completed_onboarding: 0,
					created_at: now,
					updated_at: now,
				},
			]);

			return {
				id,
				name: user.name ?? null,
				email: normalizedEmail,
				emailVerified: user.emailVerified ?? null,
				image: user.image ?? null,
			} as AdapterUser;
		},

		async getUser(id) {
			const row = await systemQueryFirst<UserRow>(
				`SELECT * FROM openlit_users WHERE id = {id:String} LIMIT 1`,
				{ id }
			);
			return row ? rowToAdapterUser(row) : null;
		},

		async getUserByEmail(email) {
			const normalizedEmail = email.toLowerCase().trim();
			const row = await systemQueryFirst<UserRow>(
				`SELECT * FROM openlit_users WHERE email = {email:String} LIMIT 1`,
				{ email: normalizedEmail }
			);
			return row ? rowToAdapterUser(row) : null;
		},

		async getUserByAccount({ providerAccountId, provider }) {
			const row = await systemQueryFirst<{ user_id: string }>(
				`SELECT user_id FROM openlit_accounts WHERE provider = {provider:String} AND provider_account_id = {providerAccountId:String} LIMIT 1`,
				{ provider, providerAccountId }
			);
			if (!row) return null;

			const userRow = await systemQueryFirst<UserRow>(
				`SELECT * FROM openlit_users WHERE id = {id:String} LIMIT 1`,
				{ id: row.user_id }
			);
			return userRow ? rowToAdapterUser(userRow) : null;
		},

		async updateUser(user) {
			const sets: string[] = [];
			if (user.name !== undefined) sets.push(`name = {name:String}`);
			if (user.email !== undefined) sets.push(`email = {email:String}`);
			if (user.image !== undefined) sets.push(`image = {image:String}`);
			if (user.emailVerified !== undefined)
				sets.push(`email_verified = {emailVerified:String}`);
			sets.push(`updated_at = now64(3)`);

			if (sets.length > 0) {
				await systemExec(
					`ALTER TABLE openlit_users UPDATE ${sets.join(", ")} WHERE id = '${user.id}'`
				);
			}

			const row = await systemQueryFirst<UserRow>(
				`SELECT * FROM openlit_users WHERE id = {id:String} LIMIT 1`,
				{ id: user.id! }
			);
			return row ? rowToAdapterUser(row) : ({ id: user.id } as AdapterUser);
		},

		async deleteUser(userId) {
			await systemExec(
				`ALTER TABLE openlit_accounts DELETE WHERE user_id = '${userId}'`
			);
			await systemExec(
				`ALTER TABLE openlit_sessions DELETE WHERE user_id = '${userId}'`
			);
			await systemExec(
				`ALTER TABLE openlit_users DELETE WHERE id = '${userId}'`
			);
		},

		async linkAccount(account) {
			const id = generateId();
			const now = new Date().toISOString();

			await systemInsert("openlit_accounts", [
				{
					id,
					user_id: account.userId,
					type: account.type ?? null,
					provider: account.provider,
					provider_account_id: account.providerAccountId,
					token_type: account.token_type ?? null,
					refresh_token: account.refresh_token ?? null,
					access_token: account.access_token ?? null,
					expires_at: account.expires_at ?? null,
					scope: account.scope ?? null,
					id_token: account.id_token ?? null,
					created_at: now,
					updated_at: now,
				},
			]);

			return account as AdapterAccount;
		},

		async unlinkAccount({ providerAccountId, provider }) {
			await systemExec(
				`ALTER TABLE openlit_accounts DELETE WHERE provider = '${provider}' AND provider_account_id = '${providerAccountId}'`
			);
		},

		async createSession(session) {
			const id = generateId();
			const now = new Date().toISOString();

			await systemInsert("openlit_sessions", [
				{
					id,
					user_id: session.userId,
					session_token: session.sessionToken,
					access_token: null,
					expires: session.expires.toISOString(),
					created_at: now,
					updated_at: now,
				},
			]);

			return {
				sessionToken: session.sessionToken,
				userId: session.userId,
				expires: session.expires,
			};
		},

		async getSessionAndUser(sessionToken) {
			const sessionRow = await systemQueryFirst<SessionRow>(
				`SELECT * FROM openlit_sessions WHERE session_token = {token:String} LIMIT 1`,
				{ token: sessionToken }
			);
			if (!sessionRow || !sessionRow.user_id) return null;

			const userRow = await systemQueryFirst<UserRow>(
				`SELECT * FROM openlit_users WHERE id = {id:String} LIMIT 1`,
				{ id: sessionRow.user_id }
			);
			if (!userRow) return null;

			return {
				session: rowToSession(sessionRow),
				user: rowToAdapterUser(userRow),
			};
		},

		async updateSession(session) {
			const sets: string[] = [];
			if (session.expires)
				sets.push(`expires = '${session.expires.toISOString()}'`);
			if (session.userId) sets.push(`user_id = '${session.userId}'`);
			sets.push(`updated_at = now64(3)`);

			await systemExec(
				`ALTER TABLE openlit_sessions UPDATE ${sets.join(", ")} WHERE session_token = '${session.sessionToken}'`
			);

			const row = await systemQueryFirst<SessionRow>(
				`SELECT * FROM openlit_sessions WHERE session_token = {token:String} LIMIT 1`,
				{ token: session.sessionToken }
			);
			return row ? rowToSession(row) : null;
		},

		async deleteSession(sessionToken) {
			await systemExec(
				`ALTER TABLE openlit_sessions DELETE WHERE session_token = '${sessionToken}'`
			);
		},

		async createVerificationToken(token) {
			const id = generateId();
			const now = new Date().toISOString();

			await systemInsert("openlit_verification_requests", [
				{
					id,
					identifier: token.identifier,
					token: token.token,
					expires: token.expires.toISOString(),
					created_at: now,
					updated_at: now,
				},
			]);

			return token;
		},

		async useVerificationToken({ identifier, token }) {
			const row = await systemQueryFirst<{
				identifier: string;
				token: string;
				expires: string;
			}>(
				`SELECT identifier, token, expires FROM openlit_verification_requests WHERE identifier = {identifier:String} AND token = {token:String} LIMIT 1`,
				{ identifier, token }
			);
			if (!row) return null;

			await systemExec(
				`ALTER TABLE openlit_verification_requests DELETE WHERE identifier = '${identifier}' AND token = '${token}'`
			);

			return {
				identifier: row.identifier,
				token: row.token,
				expires: new Date(row.expires),
			};
		},
	};
}
