import { compare, genSaltSync, hashSync } from "bcrypt-ts";
import {
	systemQuery,
	systemQueryFirst,
	systemInsert,
	systemExec,
} from "./system-db";
import asaw from "@/utils/asaw";
import { getCurrentUser } from "./session";
import { User } from "@/lib/models";
import { generateId } from "@/lib/id";
import { moveSharedDBConfigToDBUser } from "./db-config";
import { moveInvitationsToMembership } from "./organisation";
import getMessage from "@/constants/messages";

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

function rowToUser(r: UserRow): User {
	return {
		id: r.id,
		name: r.name,
		email: r.email,
		emailVerified: r.email_verified ? new Date(r.email_verified) : null,
		password: r.password,
		image: r.image,
		hasCompletedOnboarding: !!r.has_completed_onboarding,
		createdAt: new Date(r.created_at),
		updatedAt: new Date(r.updated_at),
	};
}

function exclude<T extends object, K extends keyof T>(
	user: T,
	keys: K[] = ["password" as unknown as K] as K[]
): Omit<T, K> {
	return Object.fromEntries(
		Object.entries(user).filter(([key]) =>
			typeof keys.includes === "function" ? !keys.includes(key as K) : true
		)
	) as Omit<T, K>;
}

export const getUserByEmail = async ({
	email,
	selectPassword = false,
}: {
	email?: string;
	selectPassword?: boolean;
}) => {
	if (!email) throw new Error("No email Provided");

	// Normalize email to lowercase for case-insensitive comparison
	const normalizedEmail = email.toLowerCase().trim();

	const row = await systemQueryFirst<UserRow>(
		`SELECT * FROM openlit_users WHERE email = {email:String} LIMIT 1`,
		{ email: normalizedEmail }
	);

	if (!row) throw new Error("No user with this email exists");

	const user = rowToUser(row);
	return exclude(user, selectPassword ? [] : undefined);
};

export const getUserById = async ({
	id,
	selectPassword = false,
}: {
	id?: string;
	selectPassword?: boolean;
}) => {
	if (!id) return null;
	const row = await systemQueryFirst<UserRow>(
		`SELECT * FROM openlit_users WHERE id = {id:String} LIMIT 1`,
		{ id }
	);

	if (!row) return null;

	const user = rowToUser(row);
	return exclude(user, selectPassword ? [] : undefined);
};

export const createNewUser = async (
	{
		email,
		password,
	}: {
		email: string;
		password: string;
	},
	options?: { selectPassword?: boolean }
) => {
	// Normalize email to lowercase for case-insensitive comparison
	const normalizedEmail = email.toLowerCase().trim();

	const [, existingUser] = await asaw(
		getUserByEmail({ email: normalizedEmail })
	);
	if (existingUser) throw new Error("User already exists! Please signin!");

	const hashedPassword = getHashedPassword(password);
	const id = generateId();
	const now = new Date().toISOString();

	await systemInsert("openlit_users", [
		{
			id,
			email: normalizedEmail,
			password: hashedPassword,
			has_completed_onboarding: 0,
			name: null,
			email_verified: null,
			image: null,
			created_at: now,
			updated_at: now,
		},
	]);

	const createdUser: User = {
		id,
		email: normalizedEmail,
		password: hashedPassword,
		hasCompletedOnboarding: false,
		name: null,
		emailVerified: null,
		image: null,
		createdAt: new Date(now),
		updatedAt: new Date(now),
	};

	await moveSharedDBConfigToDBUser(normalizedEmail, createdUser.id);
	await moveInvitationsToMembership(normalizedEmail, createdUser.id);
	return exclude(createdUser, options?.selectPassword ? [] : undefined);
};

export const updateUser = async ({
	data,
	where,
}: {
	data: any;
	where: any;
}) => {
	if (!where || !Object.keys(where).length)
		throw new Error("No where clause defined");

	const sets: string[] = [];
	const fieldMap: Record<string, string> = {
		name: "name",
		email: "email",
		image: "image",
		password: "password",
		hasCompletedOnboarding: "has_completed_onboarding",
	};

	for (const [key, col] of Object.entries(fieldMap)) {
		if (data[key] !== undefined) {
			if (key === "hasCompletedOnboarding") {
				sets.push(`${col} = ${data[key] ? 1 : 0}`);
			} else {
				const escaped = String(data[key]).replace(/'/g, "\\'");
				sets.push(`${col} = '${escaped}'`);
			}
		}
	}
	sets.push(`updated_at = now64(3)`);

	let condition = "";
	if (where.id) condition = `id = '${where.id}'`;
	else if (where.email) condition = `email = '${where.email.toLowerCase().trim()}'`;
	else throw new Error("Unsupported where clause");

	await systemExec(
		`ALTER TABLE openlit_users UPDATE ${sets.join(", ")} WHERE ${condition}`
	);

	// Return the updated user
	const row = await systemQueryFirst<UserRow>(
		where.id
			? `SELECT * FROM openlit_users WHERE id = {id:String} LIMIT 1`
			: `SELECT * FROM openlit_users WHERE email = {email:String} LIMIT 1`,
		where.id ? { id: where.id } : { email: where.email.toLowerCase().trim() }
	);
	return row ? rowToUser(row) : null;
};

export const updateUserProfile = async ({
	currentPassword,
	newPassword,
	name,
}: {
	currentPassword?: string;
	newPassword?: string;
	name?: string;
}) => {
	const user = await getCurrentUser({ selectPassword: true });

	if (!user) throw new Error(getMessage().UNAUTHORIZED_USER);

	const updatedUserObject: Partial<User> = {};

	if (newPassword) {
		if (!currentPassword)
			throw new Error("Provide current password to update it to new one!");
		const passwordsMatch = await doesPasswordMatches(
			currentPassword,
			user.password || ""
		);
		if (!passwordsMatch) throw new Error("Wrong current password!");
		updatedUserObject.password = getHashedPassword(newPassword);
	}

	if (name) {
		updatedUserObject.name = name;
	}

	if (Object.keys(updatedUserObject).length === 0)
		throw new Error("Nothing to update!");

	return updateUser({
		data: updatedUserObject,
		where: { id: user.id },
	});
};

const getHashedPassword = (password: string): string => {
	const salt = genSaltSync(10);
	const hash = hashSync(password, salt);
	return hash;
};

export const doesPasswordMatches = async (
	password: string,
	userPassword: string
): Promise<boolean> => {
	return await compare(password, userPassword);
};
