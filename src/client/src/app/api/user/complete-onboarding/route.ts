import { systemExec } from "@/lib/system-db";
import { getCurrentUser } from "@/lib/session";
import asaw from "@/utils/asaw";

export async function POST() {
	const [err, user] = await asaw(getCurrentUser());

	if (err || !user) {
		return Response.json("Unauthorized", {
			status: 401,
		});
	}

	await systemExec(
		`ALTER TABLE openlit_users UPDATE has_completed_onboarding = 1, updated_at = now64(3) WHERE id = '${user.id}'`
	);

	return Response.json({ success: true });
}
