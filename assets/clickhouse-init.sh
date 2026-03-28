#!/bin/bash
set -e

echo "==================== ClickHouse Initialization ===================="

# Cluster support: when CLICKHOUSE_CLUSTER is set, use ON CLUSTER and ReplicatedMergeTree
if [ -n "${CLICKHOUSE_CLUSTER}" ]; then
  ON_CLUSTER="ON CLUSTER '${CLICKHOUSE_CLUSTER}'"
  ENGINE="ReplicatedMergeTree"
  echo "Cluster mode enabled: ${CLICKHOUSE_CLUSTER}"
else
  ON_CLUSTER=""
  ENGINE="MergeTree"
  echo "Single-node mode (no cluster)"
fi

clickhouse-client --query "CREATE DATABASE IF NOT EXISTS ${CLICKHOUSE_DATABASE} ${ON_CLUSTER}"

echo "Database $CLICKHOUSE_DATABASE created successfully"
echo ""
echo "Creating OTEL tables required by OpenTelemetry Collector..."

clickhouse-client --database="${CLICKHOUSE_DATABASE}" --query "
CREATE TABLE IF NOT EXISTS otel_traces ${ON_CLUSTER}
(
    \`Timestamp\` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    \`TraceId\` String CODEC(ZSTD(1)),
    \`SpanId\` String CODEC(ZSTD(1)),
    \`ParentSpanId\` String CODEC(ZSTD(1)),
    \`TraceState\` String CODEC(ZSTD(1)),
    \`SpanName\` LowCardinality(String) CODEC(ZSTD(1)),
    \`SpanKind\` LowCardinality(String) CODEC(ZSTD(1)),
    \`ServiceName\` LowCardinality(String) CODEC(ZSTD(1)),
    \`ResourceAttributes\` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    \`ScopeName\` String CODEC(ZSTD(1)),
    \`ScopeVersion\` String CODEC(ZSTD(1)),
    \`SpanAttributes\` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    \`Duration\` UInt64 CODEC(ZSTD(1)),
    \`StatusCode\` LowCardinality(String) CODEC(ZSTD(1)),
    \`StatusMessage\` String CODEC(ZSTD(1)),
    \`Events.Timestamp\` Array(DateTime64(9)) CODEC(ZSTD(1)),
    \`Events.Name\` Array(LowCardinality(String)) CODEC(ZSTD(1)),
    \`Events.Attributes\` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    \`Links.TraceId\` Array(String) CODEC(ZSTD(1)),
    \`Links.SpanId\` Array(String) CODEC(ZSTD(1)),
    \`Links.TraceState\` Array(String) CODEC(ZSTD(1)),
    \`Links.Attributes\` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_span_attr_key mapKeys(SpanAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_span_attr_value mapValues(SpanAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_duration Duration TYPE minmax GRANULARITY 1
)
ENGINE = ${ENGINE}
PARTITION BY toDate(Timestamp)
ORDER BY (ServiceName, SpanName, toDateTime(Timestamp))
TTL toDateTime(Timestamp) + toIntervalHour(730)
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1
"

clickhouse-client --database="${CLICKHOUSE_DATABASE}" --query "
CREATE TABLE IF NOT EXISTS otel_logs ${ON_CLUSTER}
(
    \`Timestamp\` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    \`TimestampTime\` DateTime DEFAULT toDateTime(Timestamp),
    \`TraceId\` String CODEC(ZSTD(1)),
    \`SpanId\` String CODEC(ZSTD(1)),
    \`TraceFlags\` UInt8,
    \`SeverityText\` LowCardinality(String) CODEC(ZSTD(1)),
    \`SeverityNumber\` UInt8,
    \`ServiceName\` LowCardinality(String) CODEC(ZSTD(1)),
    \`Body\` String CODEC(ZSTD(1)),
    \`ResourceSchemaUrl\` LowCardinality(String) CODEC(ZSTD(1)),
    \`ResourceAttributes\` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    \`ScopeSchemaUrl\` LowCardinality(String) CODEC(ZSTD(1)),
    \`ScopeName\` String CODEC(ZSTD(1)),
    \`ScopeVersion\` LowCardinality(String) CODEC(ZSTD(1)),
    \`ScopeAttributes\` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    \`LogAttributes\` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_log_attr_key mapKeys(LogAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_log_attr_value mapValues(LogAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_body Body TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 8
)
ENGINE = ${ENGINE}
PARTITION BY toDate(TimestampTime)
PRIMARY KEY (ServiceName, TimestampTime)
ORDER BY (ServiceName, TimestampTime, Timestamp)
TTL TimestampTime + toIntervalHour(730)
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1
"

clickhouse-client --database="${CLICKHOUSE_DATABASE}" --query "
CREATE TABLE IF NOT EXISTS otel_metrics_gauge ${ON_CLUSTER}
(
    \`ResourceAttributes\` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    \`ResourceSchemaUrl\` String CODEC(ZSTD(1)),
    \`ScopeName\` String CODEC(ZSTD(1)),
    \`ScopeVersion\` String CODEC(ZSTD(1)),
    \`ScopeAttributes\` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    \`ScopeDroppedAttrCount\` UInt32 CODEC(ZSTD(1)),
    \`ScopeSchemaUrl\` String CODEC(ZSTD(1)),
    \`ServiceName\` LowCardinality(String) CODEC(ZSTD(1)),
    \`MetricName\` String CODEC(ZSTD(1)),
    \`MetricDescription\` String CODEC(ZSTD(1)),
    \`MetricUnit\` String CODEC(ZSTD(1)),
    \`Attributes\` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    \`StartTimeUnix\` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    \`TimeUnix\` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    \`Value\` Float64 CODEC(ZSTD(1)),
    \`Flags\` UInt32 CODEC(ZSTD(1)),
    \`Exemplars.FilteredAttributes\` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    \`Exemplars.TimeUnix\` Array(DateTime64(9)) CODEC(ZSTD(1)),
    \`Exemplars.Value\` Array(Float64) CODEC(ZSTD(1)),
    \`Exemplars.SpanId\` Array(String) CODEC(ZSTD(1)),
    \`Exemplars.TraceId\` Array(String) CODEC(ZSTD(1)),
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = ${ENGINE}
PARTITION BY toDate(TimeUnix)
ORDER BY (ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix))
TTL toDateTime(TimeUnix) + toIntervalHour(730)
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1
"

clickhouse-client --database="${CLICKHOUSE_DATABASE}" --query "
CREATE TABLE IF NOT EXISTS otel_metrics_sum ${ON_CLUSTER}
(
    \`ResourceAttributes\` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    \`ResourceSchemaUrl\` String CODEC(ZSTD(1)),
    \`ScopeName\` String CODEC(ZSTD(1)),
    \`ScopeVersion\` String CODEC(ZSTD(1)),
    \`ScopeAttributes\` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    \`ScopeDroppedAttrCount\` UInt32 CODEC(ZSTD(1)),
    \`ScopeSchemaUrl\` String CODEC(ZSTD(1)),
    \`ServiceName\` LowCardinality(String) CODEC(ZSTD(1)),
    \`MetricName\` String CODEC(ZSTD(1)),
    \`MetricDescription\` String CODEC(ZSTD(1)),
    \`MetricUnit\` String CODEC(ZSTD(1)),
    \`Attributes\` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    \`StartTimeUnix\` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    \`TimeUnix\` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    \`Value\` Float64 CODEC(ZSTD(1)),
    \`Flags\` UInt32 CODEC(ZSTD(1)),
    \`Exemplars.FilteredAttributes\` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    \`Exemplars.TimeUnix\` Array(DateTime64(9)) CODEC(ZSTD(1)),
    \`Exemplars.Value\` Array(Float64) CODEC(ZSTD(1)),
    \`Exemplars.SpanId\` Array(String) CODEC(ZSTD(1)),
    \`Exemplars.TraceId\` Array(String) CODEC(ZSTD(1)),
    \`AggregationTemporality\` Int32 CODEC(ZSTD(1)),
    \`IsMonotonic\` Bool CODEC(Delta(1), ZSTD(1)),
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = ${ENGINE}
PARTITION BY toDate(TimeUnix)
ORDER BY (ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix))
TTL toDateTime(TimeUnix) + toIntervalHour(730)
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1
"

clickhouse-client --database="${CLICKHOUSE_DATABASE}" --query "
CREATE TABLE IF NOT EXISTS otel_metrics_histogram ${ON_CLUSTER}
(
    \`ResourceAttributes\` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    \`ResourceSchemaUrl\` String CODEC(ZSTD(1)),
    \`ScopeName\` String CODEC(ZSTD(1)),
    \`ScopeVersion\` String CODEC(ZSTD(1)),
    \`ScopeAttributes\` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    \`ScopeDroppedAttrCount\` UInt32 CODEC(ZSTD(1)),
    \`ScopeSchemaUrl\` String CODEC(ZSTD(1)),
    \`ServiceName\` LowCardinality(String) CODEC(ZSTD(1)),
    \`MetricName\` String CODEC(ZSTD(1)),
    \`MetricDescription\` String CODEC(ZSTD(1)),
    \`MetricUnit\` String CODEC(ZSTD(1)),
    \`Attributes\` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    \`StartTimeUnix\` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    \`TimeUnix\` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    \`Count\` UInt64 CODEC(Delta(8), ZSTD(1)),
    \`Sum\` Float64 CODEC(ZSTD(1)),
    \`BucketCounts\` Array(UInt64) CODEC(ZSTD(1)),
    \`ExplicitBounds\` Array(Float64) CODEC(ZSTD(1)),
    \`Exemplars.FilteredAttributes\` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    \`Exemplars.TimeUnix\` Array(DateTime64(9)) CODEC(ZSTD(1)),
    \`Exemplars.Value\` Array(Float64) CODEC(ZSTD(1)),
    \`Exemplars.SpanId\` Array(String) CODEC(ZSTD(1)),
    \`Exemplars.TraceId\` Array(String) CODEC(ZSTD(1)),
    \`Flags\` UInt32 CODEC(ZSTD(1)),
    \`Min\` Float64 CODEC(ZSTD(1)),
    \`Max\` Float64 CODEC(ZSTD(1)),
    \`AggregationTemporality\` Int32 CODEC(ZSTD(1)),
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = ${ENGINE}
PARTITION BY toDate(TimeUnix)
ORDER BY (ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix))
TTL toDateTime(TimeUnix) + toIntervalHour(730)
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1
"

clickhouse-client --database="${CLICKHOUSE_DATABASE}" --query "
CREATE TABLE IF NOT EXISTS otel_metrics_summary ${ON_CLUSTER}
(
    \`ResourceAttributes\` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    \`ResourceSchemaUrl\` String CODEC(ZSTD(1)),
    \`ScopeName\` String CODEC(ZSTD(1)),
    \`ScopeVersion\` String CODEC(ZSTD(1)),
    \`ScopeAttributes\` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    \`ScopeDroppedAttrCount\` UInt32 CODEC(ZSTD(1)),
    \`ScopeSchemaUrl\` String CODEC(ZSTD(1)),
    \`ServiceName\` LowCardinality(String) CODEC(ZSTD(1)),
    \`MetricName\` String CODEC(ZSTD(1)),
    \`MetricDescription\` String CODEC(ZSTD(1)),
    \`MetricUnit\` String CODEC(ZSTD(1)),
    \`Attributes\` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    \`StartTimeUnix\` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    \`TimeUnix\` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    \`Count\` UInt64 CODEC(Delta(8), ZSTD(1)),
    \`Sum\` Float64 CODEC(ZSTD(1)),
    \`ValueAtQuantiles.Quantile\` Array(Float64) CODEC(ZSTD(1)),
    \`ValueAtQuantiles.Value\` Array(Float64) CODEC(ZSTD(1)),
    \`Flags\` UInt32 CODEC(ZSTD(1)),
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = ${ENGINE}
PARTITION BY toDate(TimeUnix)
ORDER BY (ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix))
TTL toDateTime(TimeUnix) + toIntervalHour(730)
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1
"

clickhouse-client --database="${CLICKHOUSE_DATABASE}" --query "
CREATE TABLE IF NOT EXISTS otel_metrics_exponential_histogram ${ON_CLUSTER}
(
    \`ResourceAttributes\` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    \`ResourceSchemaUrl\` String CODEC(ZSTD(1)),
    \`ScopeName\` String CODEC(ZSTD(1)),
    \`ScopeVersion\` String CODEC(ZSTD(1)),
    \`ScopeAttributes\` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    \`ScopeDroppedAttrCount\` UInt32 CODEC(ZSTD(1)),
    \`ScopeSchemaUrl\` String CODEC(ZSTD(1)),
    \`ServiceName\` LowCardinality(String) CODEC(ZSTD(1)),
    \`MetricName\` String CODEC(ZSTD(1)),
    \`MetricDescription\` String CODEC(ZSTD(1)),
    \`MetricUnit\` String CODEC(ZSTD(1)),
    \`Attributes\` Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    \`StartTimeUnix\` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    \`TimeUnix\` DateTime64(9) CODEC(Delta(8), ZSTD(1)),
    \`Count\` UInt64 CODEC(Delta(8), ZSTD(1)),
    \`Sum\` Float64 CODEC(ZSTD(1)),
    \`Scale\` Int32 CODEC(ZSTD(1)),
    \`ZeroCount\` UInt64 CODEC(ZSTD(1)),
    \`PositiveOffset\` Int32 CODEC(ZSTD(1)),
    \`PositiveBucketCounts\` Array(UInt64) CODEC(ZSTD(1)),
    \`NegativeOffset\` Int32 CODEC(ZSTD(1)),
    \`NegativeBucketCounts\` Array(UInt64) CODEC(ZSTD(1)),
    \`Exemplars.FilteredAttributes\` Array(Map(LowCardinality(String), String)) CODEC(ZSTD(1)),
    \`Exemplars.TimeUnix\` Array(DateTime64(9)) CODEC(ZSTD(1)),
    \`Exemplars.Value\` Array(Float64) CODEC(ZSTD(1)),
    \`Exemplars.SpanId\` Array(String) CODEC(ZSTD(1)),
    \`Exemplars.TraceId\` Array(String) CODEC(ZSTD(1)),
    \`Flags\` UInt32 CODEC(ZSTD(1)),
    \`Min\` Float64 CODEC(ZSTD(1)),
    \`Max\` Float64 CODEC(ZSTD(1)),
    \`AggregationTemporality\` Int32 CODEC(ZSTD(1)),
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_key mapKeys(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_scope_attr_value mapValues(ScopeAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_key mapKeys(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_attr_value mapValues(Attributes) TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = ${ENGINE}
PARTITION BY toDate(TimeUnix)
ORDER BY (ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix))
TTL toDateTime(TimeUnix) + toIntervalHour(730)
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1
"

clickhouse-client --database="${CLICKHOUSE_DATABASE}" --query "
CREATE TABLE IF NOT EXISTS otel_traces_trace_id_ts ${ON_CLUSTER}
(
    \`TraceId\` String CODEC(ZSTD(1)),
    \`Start\` DateTime CODEC(Delta(4), ZSTD(1)),
    \`End\` DateTime CODEC(Delta(4), ZSTD(1)),
    INDEX idx_trace_id TraceId TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = ${ENGINE}
PARTITION BY toDate(Start)
ORDER BY (TraceId, Start)
TTL toDateTime(Start) + toIntervalHour(730)
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1
"

clickhouse-client --database="${CLICKHOUSE_DATABASE}" --query "
CREATE MATERIALIZED VIEW IF NOT EXISTS otel_traces_trace_id_ts_mv ${ON_CLUSTER} TO otel_traces_trace_id_ts
(
    \`TraceId\` String,
    \`Start\` DateTime64(9),
    \`End\` DateTime64(9)
)
AS SELECT
    TraceId,
    min(Timestamp) AS Start,
    max(Timestamp) AS End
FROM otel_traces
WHERE TraceId != ''
GROUP BY TraceId
"

echo "✅ All 9 OTEL tables created successfully"
echo ""
echo "Creating system tables for application state..."

# ---- Users ----
clickhouse-client --database="${CLICKHOUSE_DATABASE}" --query "
CREATE TABLE IF NOT EXISTS openlit_users ${ON_CLUSTER}
(
    id String,
    name Nullable(String),
    email String,
    email_verified Nullable(DateTime64(3)),
    password Nullable(String),
    image Nullable(String),
    has_completed_onboarding UInt8 DEFAULT 0,
    created_at DateTime64(3) DEFAULT now64(3),
    updated_at DateTime64(3) DEFAULT now64(3),

    INDEX idx_email email TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = ${ENGINE}
ORDER BY (id)
SETTINGS index_granularity = 8192
"

# ---- Accounts (OAuth) ----
clickhouse-client --database="${CLICKHOUSE_DATABASE}" --query "
CREATE TABLE IF NOT EXISTS openlit_accounts ${ON_CLUSTER}
(
    id String,
    user_id String,
    type Nullable(String),
    provider String,
    provider_account_id String,
    token_type Nullable(String),
    refresh_token Nullable(String),
    access_token Nullable(String),
    expires_at Nullable(Int64),
    scope Nullable(String),
    id_token Nullable(String),
    created_at DateTime64(3) DEFAULT now64(3),
    updated_at DateTime64(3) DEFAULT now64(3),

    INDEX idx_user_id user_id TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_provider_account (provider, provider_account_id) TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = ${ENGINE}
ORDER BY (id)
SETTINGS index_granularity = 8192
"

# ---- Sessions ----
clickhouse-client --database="${CLICKHOUSE_DATABASE}" --query "
CREATE TABLE IF NOT EXISTS openlit_sessions ${ON_CLUSTER}
(
    id String,
    user_id Nullable(String),
    session_token String,
    access_token Nullable(String),
    expires DateTime64(3),
    created_at DateTime64(3) DEFAULT now64(3),
    updated_at DateTime64(3) DEFAULT now64(3),

    INDEX idx_session_token session_token TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_user_id user_id TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = ${ENGINE}
ORDER BY (id)
SETTINGS index_granularity = 8192
"

# ---- Verification Requests ----
clickhouse-client --database="${CLICKHOUSE_DATABASE}" --query "
CREATE TABLE IF NOT EXISTS openlit_verification_requests ${ON_CLUSTER}
(
    id String,
    identifier String,
    token String,
    expires DateTime64(3),
    created_at DateTime64(3) DEFAULT now64(3),
    updated_at DateTime64(3) DEFAULT now64(3),

    INDEX idx_token token TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_identifier_token (identifier, token) TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = ${ENGINE}
ORDER BY (id)
SETTINGS index_granularity = 8192
"

# ---- Organisations ----
clickhouse-client --database="${CLICKHOUSE_DATABASE}" --query "
CREATE TABLE IF NOT EXISTS openlit_organisations ${ON_CLUSTER}
(
    id String,
    name String,
    slug String,
    created_at DateTime64(3) DEFAULT now64(3),
    updated_at DateTime64(3) DEFAULT now64(3),
    created_by_user_id String,

    INDEX idx_slug slug TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = ${ENGINE}
ORDER BY (id)
SETTINGS index_granularity = 8192
"

# ---- Organisation Users ----
clickhouse-client --database="${CLICKHOUSE_DATABASE}" --query "
CREATE TABLE IF NOT EXISTS openlit_organisation_users ${ON_CLUSTER}
(
    id String,
    organisation_id String,
    user_id String,
    role String DEFAULT 'member',
    is_current UInt8 DEFAULT 0,
    created_at DateTime64(3) DEFAULT now64(3),
    updated_at DateTime64(3) DEFAULT now64(3),

    INDEX idx_org_user (organisation_id, user_id) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_user_id user_id TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = ${ENGINE}
ORDER BY (id)
SETTINGS index_granularity = 8192
"

# ---- Organisation Invited Users ----
clickhouse-client --database="${CLICKHOUSE_DATABASE}" --query "
CREATE TABLE IF NOT EXISTS openlit_organisation_invited_users ${ON_CLUSTER}
(
    id String,
    organisation_id String,
    email String,
    invited_by_user_id String,
    created_at DateTime64(3) DEFAULT now64(3),

    INDEX idx_org_email (organisation_id, email) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_email email TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = ${ENGINE}
ORDER BY (id)
SETTINGS index_granularity = 8192
"

# ---- Database Config ----
clickhouse-client --database="${CLICKHOUSE_DATABASE}" --query "
CREATE TABLE IF NOT EXISTS openlit_database_configs ${ON_CLUSTER}
(
    id String,
    name String,
    environment String DEFAULT 'production',
    username String DEFAULT 'admin',
    password Nullable(String),
    host String DEFAULT '127.0.0.1',
    port String DEFAULT '8123',
    \`database\` String DEFAULT 'openlit',
    query Nullable(String),
    created_at DateTime64(3) DEFAULT now64(3),
    updated_at DateTime64(3) DEFAULT now64(3),
    user_id String,
    organisation_id Nullable(String),

    INDEX idx_name_org (name, organisation_id) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_org organisation_id TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = ${ENGINE}
ORDER BY (id)
SETTINGS index_granularity = 8192
"

# ---- Database Config Users ----
clickhouse-client --database="${CLICKHOUSE_DATABASE}" --query "
CREATE TABLE IF NOT EXISTS openlit_database_config_users ${ON_CLUSTER}
(
    database_config_id String,
    user_id String,
    is_current UInt8 DEFAULT 0,
    can_edit UInt8 DEFAULT 0,
    can_share UInt8 DEFAULT 0,
    can_delete UInt8 DEFAULT 0,
    created_at DateTime64(3) DEFAULT now64(3),
    updated_at DateTime64(3) DEFAULT now64(3),

    INDEX idx_config_user (database_config_id, user_id) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_user_id user_id TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = ${ENGINE}
ORDER BY (database_config_id, user_id)
SETTINGS index_granularity = 8192
"

# ---- Database Config Invited Users ----
clickhouse-client --database="${CLICKHOUSE_DATABASE}" --query "
CREATE TABLE IF NOT EXISTS openlit_database_config_invited_users ${ON_CLUSTER}
(
    database_config_id String,
    email String,
    can_edit UInt8 DEFAULT 0,
    can_share UInt8 DEFAULT 0,
    can_delete UInt8 DEFAULT 0,

    INDEX idx_config_email (database_config_id, email) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_email email TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = ${ENGINE}
ORDER BY (database_config_id, email)
SETTINGS index_granularity = 8192
"

# ---- API Keys ----
clickhouse-client --database="${CLICKHOUSE_DATABASE}" --query "
CREATE TABLE IF NOT EXISTS openlit_api_keys ${ON_CLUSTER}
(
    id String,
    name String DEFAULT 'default',
    api_key String,
    database_config_id String,
    is_deleted UInt8 DEFAULT 0,
    created_at DateTime64(3) DEFAULT now64(3),
    created_by_user_id String,
    deleted_at Nullable(DateTime64(3)),
    deleted_by_user_id Nullable(String),

    INDEX idx_api_key api_key TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_config_id database_config_id TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = ${ENGINE}
ORDER BY (id)
SETTINGS index_granularity = 8192
"

# ---- Evaluation Configs ----
clickhouse-client --database="${CLICKHOUSE_DATABASE}" --query "
CREATE TABLE IF NOT EXISTS openlit_evaluation_configs ${ON_CLUSTER}
(
    id String,
    database_config_id String,
    provider String,
    model String,
    vault_id String,
    auto UInt8 DEFAULT 0,
    recurring_time String,
    meta String,

    INDEX idx_config_id database_config_id TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = ${ENGINE}
ORDER BY (id)
SETTINGS index_granularity = 8192
"

# ---- ClickHouse Migrations Tracking ----
clickhouse-client --database="${CLICKHOUSE_DATABASE}" --query "
CREATE TABLE IF NOT EXISTS openlit_clickhouse_migrations ${ON_CLUSTER}
(
    id String,
    database_config_id String,
    clickhouse_migration_id String,

    INDEX idx_config_migration (database_config_id, clickhouse_migration_id) TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = ${ENGINE}
ORDER BY (id)
SETTINGS index_granularity = 8192
"

echo "✅ All system tables created successfully"
echo "===================================================================="