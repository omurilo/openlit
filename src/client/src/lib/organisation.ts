import {
	systemQuery,
	systemQueryFirst,
	systemInsert,
	systemExec,
} from "./system-db";
import { getCurrentUser } from "./session";
import getMessage from "@/constants/messages";
import { throwIfError } from "@/utils/error";
import { generateId } from "@/lib/id";

// ---- Row types ------------------------------------------------------------

interface OrgRow {
	id: string;
	name: string;
	slug: string;
	created_at: string;
	updated_at: string;
	created_by_user_id: string;
}

interface OrgUserRow {
	id: string;
	organisation_id: string;
	user_id: string;
	role: string;
	is_current: number;
	created_at: string;
}

interface OrgInviteRow {
	id: string;
	organisation_id: string;
	email: string;
	invited_by_user_id: string;
	created_at: string;
}

// ---- Slug helpers ---------------------------------------------------------

function generateOrganisationSlug(name: string): string {
	const baseSlug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
	const randomSuffix = Math.random().toString(36).substring(2, 8);
	return `${baseSlug}-${randomSuffix}`;
}

async function generateUniqueOrganisationSlug(
	name: string,
	maxRetries: number = 10
): Promise<string> {
	for (let attempt = 0; attempt < maxRetries; attempt++) {
		const slug = generateOrganisationSlug(name);
		const existing = await systemQueryFirst<{ id: string }>(
			`SELECT id FROM openlit_organisations WHERE slug = {slug:String} LIMIT 1`,
			{ slug }
		);
		if (!existing) return slug;
	}
	throw new Error(
		"Unable to generate a unique organisation slug. Please try again or use a different name."
	);
}

// ---- Permission helpers ---------------------------------------------------

async function hasAdminOrOwnerRole(
	organisationId: string,
	userId: string
): Promise<boolean> {
	const row = await systemQueryFirst<{ role: string }>(
		`SELECT role FROM openlit_organisation_users WHERE organisation_id = {orgId:String} AND user_id = {userId:String} LIMIT 1`,
		{ orgId: organisationId, userId }
	);
	if (!row) return false;
	return row.role === "owner" || row.role === "admin";
}

async function getUserRoleInOrganisation(
	organisationId: string,
	userId: string
): Promise<string | null> {
	const row = await systemQueryFirst<{ role: string }>(
		`SELECT role FROM openlit_organisation_users WHERE organisation_id = {orgId:String} AND user_id = {userId:String} LIMIT 1`,
		{ orgId: organisationId, userId }
	);
	return row?.role || null;
}

// ---- Public API -----------------------------------------------------------

export async function createOrganisation(name: string) {
	const user = await getCurrentUser();
	throwIfError(!user, getMessage().UNAUTHORIZED_USER);

	const slug = await generateUniqueOrganisationSlug(name);
	const orgId = generateId();
	const now = new Date().toISOString();

	await systemInsert("openlit_organisations", [
		{
			id: orgId,
			name,
			slug,
			created_by_user_id: user!.id,
			created_at: now,
			updated_at: now,
		},
	]);

	await systemInsert("openlit_organisation_users", [
		{
			id: generateId(),
			organisation_id: orgId,
			user_id: user!.id,
			role: "owner",
			is_current: 0,
			created_at: now,
			updated_at: now,
		},
	]);

	await migrateUserConfigsToOrganisation(orgId, user!.id);

	return { id: orgId, name, slug, createdByUserId: user!.id };
}

export async function getOrganisationsByUser() {
	const user = await getCurrentUser();
	throwIfError(!user, getMessage().UNAUTHORIZED_USER);

	const rows = await systemQuery<OrgUserRow & { org_name: string; org_slug: string; org_created_by: string; member_count: number }>(
		`SELECT
			ou.id, ou.organisation_id, ou.user_id, ou.role, ou.is_current, ou.created_at,
			o.name AS org_name, o.slug AS org_slug, o.created_by_user_id AS org_created_by,
			(SELECT count() FROM openlit_organisation_users WHERE organisation_id = ou.organisation_id) AS member_count
		FROM openlit_organisation_users ou
		INNER JOIN openlit_organisations o ON o.id = ou.organisation_id
		WHERE ou.user_id = {userId:String}
		ORDER BY o.created_at ASC`,
		{ userId: user!.id }
	);

	return rows.map((r) => ({
		id: r.organisation_id,
		name: r.org_name,
		slug: r.org_slug,
		isCurrent: !!r.is_current,
		memberCount: Number(r.member_count),
		createdByUserId: r.org_created_by,
	}));
}

export async function getCurrentOrganisation() {
	const user = await getCurrentUser();
	throwIfError(!user, getMessage().UNAUTHORIZED_USER);

	const row = await systemQueryFirst<OrgUserRow & { org_name: string; org_slug: string; org_created_by: string; member_count: number }>(
		`SELECT
			ou.id, ou.organisation_id, ou.user_id, ou.role, ou.is_current, ou.created_at,
			o.name AS org_name, o.slug AS org_slug, o.created_by_user_id AS org_created_by,
			(SELECT count() FROM openlit_organisation_users WHERE organisation_id = ou.organisation_id) AS member_count
		FROM openlit_organisation_users ou
		INNER JOIN openlit_organisations o ON o.id = ou.organisation_id
		WHERE ou.user_id = {userId:String} AND ou.is_current = 1
		LIMIT 1`,
		{ userId: user!.id }
	);

	if (!row) return null;

	return {
		id: row.organisation_id,
		name: row.org_name,
		slug: row.org_slug,
		isCurrent: true,
		memberCount: Number(row.member_count),
		createdByUserId: row.org_created_by,
	};
}

export async function setCurrentOrganisation(organisationId: string) {
	const user = await getCurrentUser();
	throwIfError(!user, getMessage().UNAUTHORIZED_USER);

	const membership = await systemQueryFirst<OrgUserRow>(
		`SELECT * FROM openlit_organisation_users WHERE organisation_id = {orgId:String} AND user_id = {userId:String} LIMIT 1`,
		{ orgId: organisationId, userId: user!.id }
	);
	throwIfError(!membership, getMessage().NOT_ORGANISATION_MEMBER);

	await systemExec(
		`ALTER TABLE openlit_organisation_users UPDATE is_current = 0 WHERE user_id = '${user!.id}' AND is_current = 1`
	);
	await systemExec(
		`ALTER TABLE openlit_organisation_users UPDATE is_current = 1 WHERE organisation_id = '${organisationId}' AND user_id = '${user!.id}'`
	);

	return { success: true };
}

export async function updateOrganisation(
	id: string,
	data: { name?: string }
) {
	const user = await getCurrentUser();
	throwIfError(!user, getMessage().UNAUTHORIZED_USER);

	const hasPermission = await hasAdminOrOwnerRole(id, user!.id);
	throwIfError(!hasPermission, getMessage().ONLY_ADMIN_CAN_UPDATE_ORGANISATION);

	if (!data.name) {
		throw new Error(getMessage().ORGANISATION_NOTHING_TO_UPDATE);
	}

	const escaped = data.name.replace(/'/g, "\\'");
	await systemExec(
		`ALTER TABLE openlit_organisations UPDATE name = '${escaped}', updated_at = now64(3) WHERE id = '${id}'`
	);

	return { id, name: data.name };
}

export async function deleteOrganisation(id: string) {
	const user = await getCurrentUser();
	throwIfError(!user, getMessage().UNAUTHORIZED_USER);

	const org = await systemQueryFirst<OrgRow>(
		`SELECT * FROM openlit_organisations WHERE id = {id:String} LIMIT 1`,
		{ id }
	);
	throwIfError(!org, getMessage().ORGANISATION_NOT_FOUND);
	throwIfError(
		org!.created_by_user_id !== user!.id,
		getMessage().ORGANISATION_ONLY_CREATOR_CAN_DELETE
	);

	const memberCount = await systemQueryFirst<{ cnt: number }>(
		`SELECT count() AS cnt FROM openlit_organisation_users WHERE organisation_id = {id:String}`,
		{ id }
	);
	throwIfError(
		Number(memberCount?.cnt || 0) > 1,
		getMessage().ORGANISATION_CANNOT_DELETE_WITH_MEMBERS
	);

	const membership = await systemQueryFirst<OrgUserRow>(
		`SELECT * FROM openlit_organisation_users WHERE organisation_id = {id:String} AND user_id = {userId:String} LIMIT 1`,
		{ id, userId: user!.id }
	);
	const wasCurrentOrg = !!membership?.is_current;

	await systemExec(`ALTER TABLE openlit_organisation_invited_users DELETE WHERE organisation_id = '${id}'`);
	await systemExec(`ALTER TABLE openlit_organisation_users DELETE WHERE organisation_id = '${id}'`);
	await systemExec(`ALTER TABLE openlit_organisations DELETE WHERE id = '${id}'`);

	if (wasCurrentOrg) {
		const remaining = await systemQueryFirst<OrgUserRow>(
			`SELECT * FROM openlit_organisation_users WHERE user_id = {userId:String} ORDER BY created_at ASC LIMIT 1`,
			{ userId: user!.id }
		);
		if (remaining) {
			await systemExec(
				`ALTER TABLE openlit_organisation_users UPDATE is_current = 1 WHERE id = '${remaining.id}'`
			);
		}
	}

	return { success: true };
}

export async function inviteUserToOrganisation(
	organisationId: string,
	email: string
) {
	const user = await getCurrentUser();
	throwIfError(!user, getMessage().UNAUTHORIZED_USER);

	const hasPermission = await hasAdminOrOwnerRole(organisationId, user!.id);
	throwIfError(!hasPermission, getMessage().ONLY_ADMIN_CAN_INVITE);

	const normalizedEmail = email.toLowerCase().trim();
	if (!normalizedEmail) throw new Error("Email cannot be empty");

	const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
	if (!EMAIL_REGEX.test(normalizedEmail)) throw new Error("Invalid email format");

	const existingUser = await systemQueryFirst<{ id: string }>(
		`SELECT id FROM openlit_users WHERE email = {email:String} LIMIT 1`,
		{ email: normalizedEmail }
	);

	if (existingUser) {
		const existingMembership = await systemQueryFirst<OrgUserRow>(
			`SELECT * FROM openlit_organisation_users WHERE organisation_id = {orgId:String} AND user_id = {userId:String} LIMIT 1`,
			{ orgId: organisationId, userId: existingUser.id }
		);
		if (existingMembership) {
			throw new Error(getMessage().USER_ALREADY_ORGANISATION_MEMBER);
		}

		await systemInsert("openlit_organisation_users", [
			{
				id: generateId(),
				organisation_id: organisationId,
				user_id: existingUser.id,
				role: "member",
				is_current: 0,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			},
		]);

		await shareOrganisationDatabaseConfigs(organisationId, existingUser.id);
		return { added: true, invited: false };
	}

	const existingInvite = await systemQueryFirst<OrgInviteRow>(
		`SELECT * FROM openlit_organisation_invited_users WHERE organisation_id = {orgId:String} AND email = {email:String} LIMIT 1`,
		{ orgId: organisationId, email: normalizedEmail }
	);
	if (existingInvite) throw new Error(getMessage().USER_ALREADY_INVITED);

	await systemInsert("openlit_organisation_invited_users", [
		{
			id: generateId(),
			organisation_id: organisationId,
			email: normalizedEmail,
			invited_by_user_id: user!.id,
			created_at: new Date().toISOString(),
		},
	]);

	return { added: false, invited: true };
}

export async function getPendingInvitationsForUser() {
	const user = await getCurrentUser();
	throwIfError(!user, getMessage().UNAUTHORIZED_USER);

	const normalizedEmail = user!.email.toLowerCase().trim();

	const rows = await systemQuery<OrgInviteRow & { org_name: string }>(
		`SELECT i.*, o.name AS org_name
		FROM openlit_organisation_invited_users i
		INNER JOIN openlit_organisations o ON o.id = i.organisation_id
		WHERE i.email = {email:String}`,
		{ email: normalizedEmail }
	);

	return rows.map((r) => ({
		id: r.id,
		organisationId: r.organisation_id,
		organisationName: r.org_name,
		invitedByUserId: r.invited_by_user_id,
		createdAt: new Date(r.created_at),
	}));
}

export async function acceptInvitation(invitationId: string) {
	const user = await getCurrentUser();
	throwIfError(!user, getMessage().UNAUTHORIZED_USER);

	const invitation = await systemQueryFirst<OrgInviteRow>(
		`SELECT * FROM openlit_organisation_invited_users WHERE id = {id:String} LIMIT 1`,
		{ id: invitationId }
	);
	throwIfError(!invitation, getMessage().INVITATION_NOT_FOUND);

	const normalizedInvitationEmail = invitation!.email.toLowerCase().trim();
	const normalizedUserEmail = user!.email.toLowerCase().trim();
	throwIfError(
		normalizedInvitationEmail !== normalizedUserEmail,
		getMessage().INVITATION_NOT_FOR_YOU
	);

	await systemInsert("openlit_organisation_users", [
		{
			id: generateId(),
			organisation_id: invitation!.organisation_id,
			user_id: user!.id,
			role: "member",
			is_current: 0,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		},
	]);

	await shareOrganisationDatabaseConfigs(invitation!.organisation_id, user!.id);

	await systemExec(
		`ALTER TABLE openlit_organisation_invited_users DELETE WHERE id = '${invitationId}'`
	);

	return { success: true };
}

export async function declineInvitation(invitationId: string) {
	const user = await getCurrentUser();
	throwIfError(!user, getMessage().UNAUTHORIZED_USER);

	const invitation = await systemQueryFirst<OrgInviteRow>(
		`SELECT * FROM openlit_organisation_invited_users WHERE id = {id:String} LIMIT 1`,
		{ id: invitationId }
	);
	throwIfError(!invitation, getMessage().INVITATION_NOT_FOUND);

	const normalizedInvitationEmail = invitation!.email.toLowerCase().trim();
	const normalizedUserEmail = user!.email.toLowerCase().trim();
	throwIfError(
		normalizedInvitationEmail !== normalizedUserEmail,
		getMessage().INVITATION_NOT_FOR_YOU
	);

	await systemExec(
		`ALTER TABLE openlit_organisation_invited_users DELETE WHERE id = '${invitationId}'`
	);

	return { success: true };
}

export async function moveInvitationsToMembership(
	email: string,
	userId: string
) {
	const normalizedEmail = email.toLowerCase().trim();

	const invitations = await systemQuery<OrgInviteRow>(
		`SELECT * FROM openlit_organisation_invited_users WHERE email = {email:String}`,
		{ email: normalizedEmail }
	);

	for (const invitation of invitations) {
		await systemInsert("openlit_organisation_users", [
			{
				id: generateId(),
				organisation_id: invitation.organisation_id,
				user_id: userId,
				role: "member",
				is_current: 0,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			},
		]);

		await shareOrganisationDatabaseConfigs(invitation.organisation_id, userId);

		await systemExec(
			`ALTER TABLE openlit_organisation_invited_users DELETE WHERE id = '${invitation.id}'`
		);
	}
}

export async function removeUserFromOrganisation(
	organisationId: string,
	userId: string
) {
	const user = await getCurrentUser();
	throwIfError(!user, getMessage().UNAUTHORIZED_USER);

	const org = await systemQueryFirst<OrgRow>(
		`SELECT * FROM openlit_organisations WHERE id = {id:String} LIMIT 1`,
		{ id: organisationId }
	);
	throwIfError(!org, getMessage().ORGANISATION_NOT_FOUND);

	const isSelfRemoval = userId === user!.id;

	if (isSelfRemoval) {
		if (userId === org!.created_by_user_id) {
			const memberCount = await systemQueryFirst<{ cnt: number }>(
				`SELECT count() AS cnt FROM openlit_organisation_users WHERE organisation_id = {id:String}`,
				{ id: organisationId }
			);
			if (Number(memberCount?.cnt || 0) > 1) {
				throw new Error(getMessage().CANNOT_LEAVE_WITH_MEMBERS);
			} else {
				throw new Error(getMessage().CREATOR_CANNOT_LEAVE_ALONE);
			}
		}
	} else {
		const currentUserRole = await getUserRoleInOrganisation(organisationId, user!.id);
		throwIfError(!currentUserRole, getMessage().NOT_ORGANISATION_MEMBER);

		const targetUserRole = await getUserRoleInOrganisation(organisationId, userId);
		const hasPermission = currentUserRole === "owner" || currentUserRole === "admin";
		throwIfError(!hasPermission, getMessage().ONLY_ADMIN_CAN_REMOVE_MEMBERS);

		if (
			(targetUserRole === "admin" || targetUserRole === "owner") &&
			currentUserRole !== "owner"
		) {
			throw new Error(getMessage().CANNOT_REMOVE_ADMIN_OR_OWNER);
		}

		if (userId === org!.created_by_user_id) {
			throw new Error(getMessage().CANNOT_REMOVE_ADMIN_OR_OWNER);
		}
	}

	const membership = await systemQueryFirst<OrgUserRow>(
		`SELECT * FROM openlit_organisation_users WHERE organisation_id = {orgId:String} AND user_id = {userId:String} LIMIT 1`,
		{ orgId: organisationId, userId }
	);
	const wasCurrentOrg = !!membership?.is_current;

	// Remove from DB config users in this org
	const orgConfigs = await systemQuery<{ id: string }>(
		`SELECT id FROM openlit_database_configs WHERE organisation_id = {orgId:String}`,
		{ orgId: organisationId }
	);
	if (orgConfigs.length > 0) {
		const configIds = orgConfigs.map((c) => `'${c.id}'`).join(",");
		await systemExec(
			`ALTER TABLE openlit_database_config_users DELETE WHERE user_id = '${userId}' AND database_config_id IN (${configIds})`
		);
	}

	await systemExec(
		`ALTER TABLE openlit_organisation_users DELETE WHERE organisation_id = '${organisationId}' AND user_id = '${userId}'`
	);

	if (wasCurrentOrg) {
		const remaining = await systemQueryFirst<OrgUserRow>(
			`SELECT * FROM openlit_organisation_users WHERE user_id = {userId:String} ORDER BY created_at ASC LIMIT 1`,
			{ userId }
		);
		if (remaining) {
			await systemExec(
				`ALTER TABLE openlit_organisation_users UPDATE is_current = 1 WHERE id = '${remaining.id}'`
			);
		}
	}

	return { success: true };
}

export async function getOrganisationMembers(organisationId: string) {
	const user = await getCurrentUser();
	throwIfError(!user, getMessage().UNAUTHORIZED_USER);

	const membership = await systemQueryFirst<OrgUserRow>(
		`SELECT * FROM openlit_organisation_users WHERE organisation_id = {orgId:String} AND user_id = {userId:String} LIMIT 1`,
		{ orgId: organisationId, userId: user!.id }
	);
	throwIfError(!membership, getMessage().NOT_ORGANISATION_MEMBER);

	const members = await systemQuery<{
		user_id: string;
		email: string;
		name: string | null;
		image: string | null;
		role: string;
		created_at: string;
	}>(
		`SELECT ou.user_id, u.email, u.name, u.image, ou.role, ou.created_at
		FROM openlit_organisation_users ou
		INNER JOIN openlit_users u ON u.id = ou.user_id
		WHERE ou.organisation_id = {orgId:String}
		ORDER BY ou.created_at ASC`,
		{ orgId: organisationId }
	);

	const org = await systemQueryFirst<OrgRow>(
		`SELECT * FROM openlit_organisations WHERE id = {id:String} LIMIT 1`,
		{ id: organisationId }
	);

	return members.map((m) => ({
		id: m.user_id,
		email: m.email,
		name: m.name,
		image: m.image,
		isCreator: m.user_id === org!.created_by_user_id,
		role: m.user_id === org!.created_by_user_id ? "owner" : m.role,
		joinedAt: new Date(m.created_at),
	}));
}

export async function updateMemberRole(
	organisationId: string,
	userId: string,
	role: string
) {
	const user = await getCurrentUser();
	throwIfError(!user, getMessage().UNAUTHORIZED_USER);

	const org = await systemQueryFirst<OrgRow>(
		`SELECT * FROM openlit_organisations WHERE id = {id:String} LIMIT 1`,
		{ id: organisationId }
	);
	throwIfError(!org, getMessage().ORGANISATION_NOT_FOUND);
	throwIfError(
		!["member", "admin"].includes(role),
		getMessage().INVALID_MEMBER_ROLE
	);
	throwIfError(
		userId === org!.created_by_user_id,
		getMessage().CANNOT_CHANGE_OWNER_ROLE
	);

	const currentUserRole = await getUserRoleInOrganisation(organisationId, user!.id);
	throwIfError(!currentUserRole, getMessage().NOT_ORGANISATION_MEMBER);

	const targetUserRole = await getUserRoleInOrganisation(organisationId, userId);
	throwIfError(!targetUserRole, getMessage().NOT_ORGANISATION_MEMBER);

	const hasPermission = currentUserRole === "owner" || currentUserRole === "admin";
	throwIfError(!hasPermission, getMessage().ONLY_ADMIN_OR_OWNER_CAN_UPDATE_ROLES);

	if (targetUserRole === "admin") {
		throwIfError(
			currentUserRole !== "owner",
			getMessage().CANNOT_CHANGE_ADMIN_ROLE
		);
	}

	await systemExec(
		`ALTER TABLE openlit_organisation_users UPDATE role = '${role}', updated_at = now64(3) WHERE organisation_id = '${organisationId}' AND user_id = '${userId}'`
	);

	return { success: true };
}

export async function getOrganisationPendingInvites(organisationId: string) {
	const user = await getCurrentUser();
	throwIfError(!user, getMessage().UNAUTHORIZED_USER);

	const membership = await systemQueryFirst<OrgUserRow>(
		`SELECT * FROM openlit_organisation_users WHERE organisation_id = {orgId:String} AND user_id = {userId:String} LIMIT 1`,
		{ orgId: organisationId, userId: user!.id }
	);
	throwIfError(!membership, getMessage().NOT_ORGANISATION_MEMBER);

	const invites = await systemQuery<OrgInviteRow>(
		`SELECT * FROM openlit_organisation_invited_users WHERE organisation_id = {orgId:String} ORDER BY created_at DESC`,
		{ orgId: organisationId }
	);

	return invites.map((i) => ({
		id: i.id,
		email: i.email,
		invitedAt: new Date(i.created_at),
	}));
}

export async function cancelInvitation(invitationId: string) {
	const user = await getCurrentUser();
	throwIfError(!user, getMessage().UNAUTHORIZED_USER);

	const invitation = await systemQueryFirst<OrgInviteRow>(
		`SELECT * FROM openlit_organisation_invited_users WHERE id = {id:String} LIMIT 1`,
		{ id: invitationId }
	);
	throwIfError(!invitation, getMessage().INVITATION_NOT_FOUND);

	const hasPermission = await hasAdminOrOwnerRole(
		invitation!.organisation_id,
		user!.id
	);
	throwIfError(!hasPermission, getMessage().ONLY_ADMIN_CAN_CANCEL_INVITATION);

	await systemExec(
		`ALTER TABLE openlit_organisation_invited_users DELETE WHERE id = '${invitationId}'`
	);

	return { success: true };
}

export async function getOrganisationById(id: string) {
	const user = await getCurrentUser();
	throwIfError(!user, getMessage().UNAUTHORIZED_USER);

	const membership = await systemQueryFirst<OrgUserRow>(
		`SELECT * FROM openlit_organisation_users WHERE organisation_id = {id:String} AND user_id = {userId:String} LIMIT 1`,
		{ id, userId: user!.id }
	);
	throwIfError(!membership, getMessage().NOT_ORGANISATION_MEMBER);

	const org = await systemQueryFirst<OrgRow & { member_count: number }>(
		`SELECT o.*, (SELECT count() FROM openlit_organisation_users WHERE organisation_id = o.id) AS member_count
		FROM openlit_organisations o WHERE o.id = {id:String} LIMIT 1`,
		{ id }
	);
	if (!org) return null;

	return {
		id: org.id,
		name: org.name,
		slug: org.slug,
		isCurrent: !!membership!.is_current,
		memberCount: Number(org.member_count),
		createdByUserId: org.created_by_user_id,
	};
}

// ---- Internal helpers -----------------------------------------------------

async function migrateUserConfigsToOrganisation(
	organisationId: string,
	userId: string
) {
	const userConfigLinks = await systemQuery<{ database_config_id: string }>(
		`SELECT dcu.database_config_id
		FROM openlit_database_config_users dcu
		INNER JOIN openlit_database_configs dc ON dc.id = dcu.database_config_id
		WHERE dcu.user_id = {userId:String} AND (dc.organisation_id IS NULL OR dc.organisation_id = '')`,
		{ userId }
	);

	if (userConfigLinks.length === 0) return;

	const orphanedConfigIds = userConfigLinks.map((l) => l.database_config_id);
	const idList = orphanedConfigIds.map((i) => `'${i}'`).join(",");

	await systemExec(
		`ALTER TABLE openlit_database_configs UPDATE organisation_id = '${organisationId}', updated_at = now64(3) WHERE id IN (${idList})`
	);

	const sharedUserLinks = await systemQuery<{ user_id: string }>(
		`SELECT DISTINCT user_id FROM openlit_database_config_users WHERE database_config_id IN (${idList}) AND user_id != {userId:String}`,
		{ userId }
	);

	for (const { user_id: sharedUserId } of sharedUserLinks) {
		const existingMembership = await systemQueryFirst<OrgUserRow>(
			`SELECT * FROM openlit_organisation_users WHERE organisation_id = {orgId:String} AND user_id = {userId:String} LIMIT 1`,
			{ orgId: organisationId, userId: sharedUserId }
		);

		const hasCurrentOrg = await systemQueryFirst<OrgUserRow>(
			`SELECT * FROM openlit_organisation_users WHERE user_id = {userId:String} AND is_current = 1 LIMIT 1`,
			{ userId: sharedUserId }
		);

		if (!existingMembership) {
			await systemInsert("openlit_organisation_users", [
				{
					id: generateId(),
					organisation_id: organisationId,
					user_id: sharedUserId,
					role: "member",
					is_current: hasCurrentOrg ? 0 : 1,
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				},
			]);
		} else if (!hasCurrentOrg) {
			await systemExec(
				`ALTER TABLE openlit_organisation_users UPDATE is_current = 1 WHERE organisation_id = '${organisationId}' AND user_id = '${sharedUserId}'`
			);
		}

		await shareOrganisationDatabaseConfigs(organisationId, sharedUserId);

		await systemExec(
			`ALTER TABLE openlit_users UPDATE has_completed_onboarding = 1 WHERE id = '${sharedUserId}'`
		);
	}
}

async function shareOrganisationDatabaseConfigs(
	organisationId: string,
	userId: string
) {
	const databaseConfigs = await systemQuery<{ id: string }>(
		`SELECT id FROM openlit_database_configs WHERE organisation_id = {orgId:String} ORDER BY created_at ASC`,
		{ orgId: organisationId }
	);

	if (databaseConfigs.length === 0) return;

	const existingCurrentConfig = await systemQueryFirst<{ database_config_id: string }>(
		`SELECT dcu.database_config_id
		FROM openlit_database_config_users dcu
		INNER JOIN openlit_database_configs dc ON dc.id = dcu.database_config_id
		WHERE dcu.user_id = {userId:String} AND dcu.is_current = 1 AND dc.organisation_id = {orgId:String}
		LIMIT 1`,
		{ userId, orgId: organisationId }
	);

	let hasAssignedCurrentToNewShare = false;

	for (const config of databaseConfigs) {
		const existingAccess = await systemQueryFirst<{ database_config_id: string }>(
			`SELECT database_config_id FROM openlit_database_config_users WHERE database_config_id = {configId:String} AND user_id = {userId:String} LIMIT 1`,
			{ configId: config.id, userId }
		);

		if (!existingAccess) {
			const shouldBeCurrent = !existingCurrentConfig && !hasAssignedCurrentToNewShare;

			await systemInsert("openlit_database_config_users", [
				{
					database_config_id: config.id,
					user_id: userId,
					is_current: shouldBeCurrent ? 1 : 0,
					can_edit: 0,
					can_share: 0,
					can_delete: 0,
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				},
			]);

			if (shouldBeCurrent) hasAssignedCurrentToNewShare = true;
		}
	}
}
