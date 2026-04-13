"""审计 135 上 token_monitor 的潜在重复计费模式。"""

import os
import sys

import paramiko


HOST = os.environ.get("SSH_HOST", "192.168.0.135")
USER = os.environ.get("SSH_USER", "root")
PWD = os.environ.get("SSH_PASSWORD", "")
REMOTE_DIR = "/opt/token-monitor"


QUERIES = [
    (
        "source_cost_breakdown",
        """
SELECT
  source,
  COUNT(*) AS rows,
  ROUND(COALESCE(SUM(cost_cny), 0)::numeric, 4) AS cost_cny,
  COUNT(*) FILTER (WHERE request_id IS NULL OR request_id = '') AS empty_request_id_rows,
  ROUND(COALESCE(SUM(total_tokens), 0)::numeric, 0) AS total_tokens
FROM token_usage_logs
GROUP BY source
ORDER BY cost_cny DESC, rows DESC;
""",
    ),
    (
        "same_source_duplicate_request_ids",
        """
SELECT
  source,
  COUNT(*) AS duplicate_request_id_groups,
  COALESCE(SUM(dup_rows), 0) AS rows_in_duplicate_groups,
  ROUND(COALESCE(SUM(dup_cost_cny), 0)::numeric, 4) AS cost_in_duplicate_groups
FROM (
  SELECT source, request_id, COUNT(*) AS dup_rows, SUM(cost_cny) AS dup_cost_cny
  FROM token_usage_logs
  WHERE request_id IS NOT NULL AND request_id <> ''
  GROUP BY source, request_id
  HAVING COUNT(*) > 1
) t
GROUP BY source
ORDER BY cost_in_duplicate_groups DESC, rows_in_duplicate_groups DESC;
""",
    ),
    (
        "cross_source_same_request_id",
        """
SELECT
  COUNT(*) AS cross_source_request_ids,
  COALESCE(SUM(total_cost_cny), 0) AS total_cost_cny
FROM (
  SELECT request_id, COUNT(DISTINCT source) AS source_count, SUM(cost_cny) AS total_cost_cny
  FROM token_usage_logs
  WHERE request_id IS NOT NULL AND request_id <> ''
  GROUP BY request_id
  HAVING COUNT(DISTINCT source) > 1
) t;
""",
    ),
    (
        "top_cross_source_request_ids",
        """
SELECT
  request_id,
  COUNT(DISTINCT source) AS source_count,
  STRING_AGG(DISTINCT source, ',' ORDER BY source) AS sources,
  ROUND(COALESCE(SUM(cost_cny), 0)::numeric, 4) AS total_cost_cny,
  COUNT(*) AS rows
FROM token_usage_logs
WHERE request_id IS NOT NULL AND request_id <> ''
GROUP BY request_id
HAVING COUNT(DISTINCT source) > 1
ORDER BY total_cost_cny DESC, rows DESC
LIMIT 20;
""",
    ),
    (
        "possible_tokscale_exact_overlap",
        """
WITH per_source AS (
  SELECT
    CAST(timezone('Asia/Shanghai', request_at) AS date) AS day,
    user_id,
    COALESCE(source_app, '') AS source_app,
    provider,
    model_name,
    source,
    SUM(cost_cny) AS cost_cny,
    SUM(total_tokens) AS total_tokens,
    SUM(COALESCE(request_count, 1)) AS requests
  FROM token_usage_logs
  GROUP BY 1,2,3,4,5,6
), grouped AS (
  SELECT
    day,
    user_id,
    source_app,
    provider,
    model_name,
    SUM(CASE WHEN source = 'tokscale' THEN cost_cny ELSE 0 END) AS tokscale_cost_cny,
    SUM(CASE WHEN source IN ('client', 'gateway') THEN cost_cny ELSE 0 END) AS exact_cost_cny,
    SUM(CASE WHEN source = 'tokscale' THEN total_tokens ELSE 0 END) AS tokscale_tokens,
    SUM(CASE WHEN source IN ('client', 'gateway') THEN total_tokens ELSE 0 END) AS exact_tokens,
    SUM(CASE WHEN source = 'tokscale' THEN requests ELSE 0 END) AS tokscale_requests,
    SUM(CASE WHEN source IN ('client', 'gateway') THEN requests ELSE 0 END) AS exact_requests
  FROM per_source
  GROUP BY 1,2,3,4,5
)
SELECT
  COUNT(*) AS overlap_groups,
  ROUND(COALESCE(SUM(tokscale_cost_cny), 0)::numeric, 4) AS tokscale_cost_cny,
  ROUND(COALESCE(SUM(exact_cost_cny), 0)::numeric, 4) AS exact_cost_cny,
  ROUND(COALESCE(SUM(LEAST(tokscale_cost_cny, exact_cost_cny)), 0)::numeric, 4) AS conservative_possible_duplicate_cost_cny
FROM grouped
WHERE tokscale_cost_cny > 0 AND exact_cost_cny > 0;
""",
    ),
    (
        "top_tokscale_exact_overlap_groups",
        """
WITH per_source AS (
  SELECT
    CAST(timezone('Asia/Shanghai', request_at) AS date) AS day,
    user_id,
    COALESCE(source_app, '') AS source_app,
    provider,
    model_name,
    source,
    SUM(cost_cny) AS cost_cny,
    SUM(total_tokens) AS total_tokens,
    SUM(COALESCE(request_count, 1)) AS requests
  FROM token_usage_logs
  GROUP BY 1,2,3,4,5,6
), grouped AS (
  SELECT
    day,
    user_id,
    source_app,
    provider,
    model_name,
    SUM(CASE WHEN source = 'tokscale' THEN cost_cny ELSE 0 END) AS tokscale_cost_cny,
    SUM(CASE WHEN source IN ('client', 'gateway') THEN cost_cny ELSE 0 END) AS exact_cost_cny,
    SUM(CASE WHEN source = 'tokscale' THEN total_tokens ELSE 0 END) AS tokscale_tokens,
    SUM(CASE WHEN source IN ('client', 'gateway') THEN total_tokens ELSE 0 END) AS exact_tokens,
    SUM(CASE WHEN source = 'tokscale' THEN requests ELSE 0 END) AS tokscale_requests,
    SUM(CASE WHEN source IN ('client', 'gateway') THEN requests ELSE 0 END) AS exact_requests
  FROM per_source
  GROUP BY 1,2,3,4,5
)
SELECT
  day,
  user_id,
  source_app,
  provider,
  model_name,
  ROUND(tokscale_cost_cny::numeric, 4) AS tokscale_cost_cny,
  ROUND(exact_cost_cny::numeric, 4) AS exact_cost_cny,
  tokscale_tokens,
  exact_tokens,
  tokscale_requests,
  exact_requests,
  ROUND(LEAST(tokscale_cost_cny, exact_cost_cny)::numeric, 4) AS conservative_overlap_cny
FROM grouped
WHERE tokscale_cost_cny > 0 AND exact_cost_cny > 0
ORDER BY conservative_overlap_cny DESC, day DESC
LIMIT 30;
""",
    ),
]


def run_remote_sql(client: paramiko.SSHClient, label: str, sql: str) -> None:
    escaped = sql.strip().replace('"', '\\"')
    cmd = (
        f"cd {REMOTE_DIR} && docker compose exec -T db "
        f"psql -U monitor -d token_monitor -P pager=off -c \"{escaped}\""
    )
    print(f"\n{'=' * 24} {label} {'=' * 24}")
    stdin, stdout, stderr = client.exec_command(cmd, timeout=300)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    if out.strip():
        print(out)
    if err.strip():
        print(err, file=sys.stderr)
    if code != 0:
        raise RuntimeError(f"query failed: {label} (exit={code})")


def main() -> None:
    if not PWD:
        print("需要: $env:SSH_PASSWORD='...'", file=sys.stderr)
        sys.exit(1)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PWD, timeout=30)
    try:
        for label, sql in QUERIES:
            run_remote_sql(client, label, sql)
    finally:
        client.close()


if __name__ == "__main__":
    main()