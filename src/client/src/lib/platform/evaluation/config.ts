import getMessage from "@/constants/messages";
import { getDBConfigByUser } from "@/lib/db-config";
import {
	systemQuery,
	systemQueryFirst,
	systemInsert,
	systemExec,
} from "@/lib/system-db";
import { generateId } from "@/lib/id";
import asaw from "@/utils/asaw";
import { throwIfError } from "@/utils/error";
import { getSecretById } from "../vault";
import { Secret } from "@/types/vault";
import {
	EvaluationConfig,
	EvaluationConfigInput,
	EvaluationConfigWithSecret,
} from "@/types/evaluation";
import { DatabaseConfig } from "@/types/database-config";
import Cron from "@/helpers/server/cron";
import { jsonParse, jsonStringify } from "@/utils/json";
import { merge } from "lodash";
import { randomUUID } from "crypto";
import path from "path";
import { EVALUATION_TYPES } from "@/constants/evaluation-types";
import { getEvaluationTypeDefaultPrompts } from "./evaluation-type-defaults";

export interface EvaluationTypeWithPrompt {
	id: string;
	label: string;
	description: string;
	enabledByDefault: boolean;
	enabled: boolean;
	isCustom?: boolean;
	rules?: Array<{ ruleId: string; priority: number }>;
	prompt?: string;
	defaultPrompt: string;
}

interface EvalConfigRow {
	id: string;
	database_config_id: string;
	provider: string;
	model: string;
	vault_id: string;
	auto: number;
	recurring_time: string;
	meta: string;
}

function rowToEvalConfig(r: EvalConfigRow): EvaluationConfig {
	return {
		id: r.id,
		databaseConfigId: r.database_config_id,
		provider: r.provider,
		model: r.model,
		vaultId: r.vault_id,
		auto: !!r.auto,
		recurringTime: r.recurring_time,
		meta: r.meta,
	};
}

async function buildEvaluationTypesWithPrompts(
	meta: Record<string, any>
): Promise<EvaluationTypeWithPrompt[]> {
	const defaultPrompts = await getEvaluationTypeDefaultPrompts();
	const userOverrides = (meta.evaluationTypes as Array<{
		id: string;
		enabled?: boolean;
		label?: string;
		description?: string;
		isCustom?: boolean;
		rules?: Array<{ ruleId: string; priority: number }>;
		prompt?: string;
	}>) || [];

	const overrideMap = new Map(
		userOverrides.filter((t) => t?.id).map((t) => [t.id, t])
	);

	const builtInIds = new Set(EVALUATION_TYPES.map((et) => et.id));

	const builtInTypes: EvaluationTypeWithPrompt[] = EVALUATION_TYPES.map((et) => {
		const override = overrideMap.get(et.id);
		return {
			id: et.id,
			label: et.label,
			description: et.description,
			enabledByDefault: et.enabledByDefault,
			enabled: override?.enabled ?? et.enabledByDefault,
			isCustom: false,
			rules: override?.rules?.filter((r) => r?.ruleId) ?? [],
			prompt: override?.prompt,
			defaultPrompt: defaultPrompts[et.id] ?? "",
		};
	});

	const customTypes: EvaluationTypeWithPrompt[] = userOverrides
		.filter((t) => t?.id && !builtInIds.has(t.id as any))
		.map((t) => ({
			id: t.id,
			label: t.label || t.id,
			description: t.description || "Custom evaluation type",
			enabledByDefault: false,
			enabled: t.enabled ?? false,
			isCustom: true,
			rules: t.rules?.filter((r) => r?.ruleId) ?? [],
			prompt: t.prompt,
			defaultPrompt: "",
		}));

	return [...builtInTypes, ...customTypes];
}

export async function getEvaluationConfig(
	dbConfig?: DatabaseConfig,
	excludeVaultValue: boolean = true,
	validateVaultId: boolean = true,
): Promise<EvaluationConfigWithSecret & { evaluationTypes?: EvaluationTypeWithPrompt[] }> {
	let updatedDBConfig: DatabaseConfig | undefined = dbConfig;
	if (!dbConfig?.id) {
		[, updatedDBConfig] = await asaw(getDBConfigByUser(true));
	}

	const row = await systemQueryFirst<EvalConfigRow>(
		`SELECT * FROM openlit_evaluation_configs WHERE database_config_id = {configId:String} LIMIT 1`,
		{ configId: updatedDBConfig!.id }
	);

	const updatedConfig = row ? rowToEvalConfig(row) : null;
	throwIfError(!updatedConfig?.id, getMessage().EVALUATION_CONFIG_NOT_FOUND);

	const { data } = await getSecretById(
		updatedConfig!.vaultId,
		updatedDBConfig!.id,
		excludeVaultValue
	);

	const updatedSecretData = (data as Secret[])?.[0] || {};

	if (validateVaultId) {
		throwIfError(
			!updatedSecretData?.id,
			getMessage().EVALUATION_VAULT_SECRET_NOT_FOUND
		);
	} else {
		if (!updatedSecretData.id) {
			updatedConfig!.vaultId = "";
		}
	}

	const meta = jsonParse(updatedConfig!.meta || "{}") as Record<string, any>;
	const evaluationTypes = await buildEvaluationTypesWithPrompts(meta);

	return {
		...updatedConfig!,
		secret: updatedSecretData,
		evaluationTypes,
	};
}

export async function setEvaluationConfig(
	evaluationConfig: EvaluationConfigInput,
	apiURL: string
) {
	const [, dbConfig] = await asaw(getDBConfigByUser(true));
	throwIfError(!dbConfig?.id, getMessage().DATABASE_CONFIG_NOT_FOUND);

	let err: any;
	let data: any;

	let previousConfig: EvaluationConfig | undefined;
	let cronJobId: string | undefined;
	let evaluationConfigId: string | undefined;

	const cronObject = new Cron();

	if (evaluationConfig.auto) {
		cronObject.validateCronSchedule(evaluationConfig.recurringTime);
	}

	if (evaluationConfig.id) {
		const row = await systemQueryFirst<EvalConfigRow>(
			`SELECT * FROM openlit_evaluation_configs WHERE id = {id:String} LIMIT 1`,
			{ id: evaluationConfig.id! }
		);
		previousConfig = row ? rowToEvalConfig(row) : undefined;

		evaluationConfigId = previousConfig?.id;
		const meta = jsonParse(previousConfig?.meta || "{}") as Record<string, any>;
		cronJobId = meta?.cronJobId || randomUUID();
		evaluationConfig.meta = jsonStringify({
			...meta,
			cronJobId,
		});
		evaluationConfig = merge(previousConfig, evaluationConfig);

		const escaped = (evaluationConfig.meta || "").replace(/'/g, "\\'");
		const autoVal = evaluationConfig.auto ? 1 : 0;
		await systemExec(
			`ALTER TABLE openlit_evaluation_configs UPDATE
				provider = '${evaluationConfig.provider}',
				model = '${evaluationConfig.model}',
				vault_id = '${evaluationConfig.vaultId}',
				auto = ${autoVal},
				recurring_time = '${evaluationConfig.recurringTime}',
				meta = '${escaped}'
			WHERE id = '${evaluationConfig.id}'`
		);
		data = { id: evaluationConfig.id };
	} else {
		cronJobId = randomUUID();
		const meta = jsonParse(evaluationConfig.meta) as Record<string, any>;
		evaluationConfig.meta = jsonStringify({
			...meta,
			cronJobId,
		});

		const id = generateId();
		evaluationConfigId = id;
		await systemInsert("openlit_evaluation_configs", [
			{
				id,
				database_config_id: dbConfig!.id,
				provider: evaluationConfig.provider,
				model: evaluationConfig.model,
				vault_id: evaluationConfig.vaultId,
				auto: evaluationConfig.auto ? 1 : 0,
				recurring_time: evaluationConfig.recurringTime,
				meta: evaluationConfig.meta,
			},
		]);
		data = { id };
	}

	try {
		if (evaluationConfig.auto) {
			await new Cron().updateCrontab({
				cronId: cronJobId!,
				cronSchedule: evaluationConfig.recurringTime,
				cronEnvVars: {
					EVALUATION_CONFIG_ID: evaluationConfigId!,
					API_URL: apiURL,
				},
				cronScriptPath: path.join(process.cwd(), "scripts/evaluation/auto.js"),
				cronLogPath: path.join(process.cwd(), "logs/evaluation/auto.log"),
			});
		} else {
			await new Cron().deleteCronJob(cronJobId!);
		}
	} catch (error) {
		console.error(getMessage().CRON_JOB_UPDATION_ERROR, error);
		throw error;
	}

	return data;
}

export async function restoreEvaluationCronJobs(apiURL: string) {
	try {
		const configs = await systemQuery<EvalConfigRow>(
			`SELECT * FROM openlit_evaluation_configs WHERE auto = 1`
		);

		if (!configs?.length) {
			console.log("No auto-evaluation configs to restore");
			return;
		}

		const cronObject = new Cron();

		for (const config of configs) {
			try {
				const meta = jsonParse(config.meta || "{}") as Record<string, any>;
				const cronJobId = meta?.cronJobId;
				if (!cronJobId || !config.recurring_time) continue;

				cronObject.updateCrontab({
					cronId: cronJobId,
					cronSchedule: config.recurring_time,
					cronEnvVars: {
						EVALUATION_CONFIG_ID: config.id,
						API_URL: apiURL,
					},
					cronScriptPath: path.join(process.cwd(), "scripts/evaluation/auto.js"),
					cronLogPath: path.join(process.cwd(), "logs/evaluation/auto.log"),
				});
				console.log(`Restored cron job for evaluation config ${config.id}`);
			} catch (e) {
				console.error(`Failed to restore cron job for config ${config.id}:`, e);
			}
		}
	} catch (e) {
		console.error("Failed to restore evaluation cron jobs:", e);
	}
}

export async function getEvaluationConfigById(
	id: string,
	excludeVaultValue: boolean = true
): Promise<EvaluationConfigWithSecret & { evaluationTypes?: EvaluationTypeWithPrompt[] }> {
	const row = await systemQueryFirst<EvalConfigRow>(
		`SELECT * FROM openlit_evaluation_configs WHERE id = {id:String} LIMIT 1`,
		{ id }
	);

	const updatedConfig = row ? rowToEvalConfig(row) : null;
	throwIfError(
		!updatedConfig?.id,
		getMessage().EVALUATION_CONFIG_NOT_FOUND
	);

	const { data: secretData } = await getSecretById(
		updatedConfig!.vaultId,
		updatedConfig!.databaseConfigId,
		excludeVaultValue
	);

	const updatedSecretData = (secretData as Secret[])?.[0] || {};

	const meta = jsonParse(updatedConfig!.meta || "{}") as Record<string, any>;
	const evaluationTypes = await buildEvaluationTypesWithPrompts(meta);

	return {
		...updatedConfig!,
		secret: updatedSecretData,
		evaluationTypes,
	};
}
