/**
 * ClickHouse cluster configuration for replicated deployments.
 *
 * When CLICKHOUSE_CLUSTER is set, all DDL statements will include
 * `ON CLUSTER <cluster>` and tables will use `ReplicatedMergeTree`
 * instead of `MergeTree`.
 *
 * When not set, the behaviour is unchanged (single-node MergeTree).
 */

const CLICKHOUSE_CLUSTER = process.env.CLICKHOUSE_CLUSTER || "";

/**
 * Returns the `ON CLUSTER '{cluster}'` clause if a cluster is configured,
 * or an empty string otherwise.
 */
export function getOnClusterClause(): string {
	if (!CLICKHOUSE_CLUSTER) return "";
	return `ON CLUSTER '${CLICKHOUSE_CLUSTER}'`;
}

/**
 * Returns the appropriate engine declaration.
 *
 * - With cluster: `ReplicatedMergeTree()`
 * - Without cluster: `MergeTree()`
 */
export function getMergeTreeEngine(): string {
	if (!CLICKHOUSE_CLUSTER) return "MergeTree()";
	return "ReplicatedMergeTree()";
}

/**
 * Convenience helper that returns both values at once.
 */
export function getClusterConfig() {
	return {
		onCluster: getOnClusterClause(),
		engine: getMergeTreeEngine(),
		isCluster: !!CLICKHOUSE_CLUSTER,
		clusterName: CLICKHOUSE_CLUSTER,
	};
}
