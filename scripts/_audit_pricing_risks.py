"""审计 135 上模型成本偏高是否来自定价映射风险。"""

import os
import sys

import paramiko


HOST = os.environ.get("SSH_HOST", "192.168.0.135")
USER = os.environ.get("SSH_USER", "root")
PWD = os.environ.get("SSH_PASSWORD", "")
REMOTE_DIR = "/opt/token-monitor"


QUERIES = [
    (
        "client_cost_by_model",
        """
SELECT
  provider,
  model_name,
  COUNT(*) AS rows,
  ROUND(SUM(total_tokens)::numeric, 0) AS total_tokens,
  ROUND(SUM(cost_cny)::numeric, 4) AS cost_cny,
  ROUND((SUM(cost_cny) / NULLIF(SUM(total_tokens), 0) * 1000)::numeric, 4) AS cny_per_1k_tokens
FROM token_usage_logs
WHERE source = 'client'
GROUP BY provider, model_name
ORDER BY cost_cny DESC, total_tokens DESC
LIMIT 20;
""",
    ),
    (
        "top_expensive_client_rows",
        """
SELECT
  id,
  request_at AT TIME ZONE 'Asia/Shanghai' AS cn_time,
  provider,
  model_name,
  input_tokens,
  output_tokens,
  total_tokens,
  cost_cny,
  source_app,
  request_id
FROM token_usage_logs
WHERE source = 'client'
ORDER BY cost_cny DESC, total_tokens DESC
LIMIT 20;
""",
    ),
    (
        "pricing_name_collisions",
        """
SELECT
  model_name,
  COUNT(*) AS active_rows,
  STRING_AGG(provider || ':' || input_price_per_1k || '/' || output_price_per_1k, ', ' ORDER BY provider) AS provider_prices
FROM model_pricing
WHERE effective_to IS NULL
GROUP BY model_name
HAVING COUNT(*) > 1
ORDER BY active_rows DESC, model_name
LIMIT 50;
""",
    ),
    (
        "top_client_models_with_pricing",
        """
WITH top_models AS (
  SELECT provider, model_name, SUM(cost_cny) AS total_cost
  FROM token_usage_logs
  WHERE source = 'client'
  GROUP BY provider, model_name
  ORDER BY total_cost DESC
  LIMIT 20
)
SELECT
  t.provider AS log_provider,
  t.model_name,
  ROUND(t.total_cost::numeric, 4) AS log_cost_cny,
  p.provider AS pricing_provider,
  p.input_price_per_1k,
  p.output_price_per_1k
FROM top_models t
LEFT JOIN model_pricing p
  ON p.model_name = t.model_name
 AND p.effective_to IS NULL
ORDER BY t.total_cost DESC, t.model_name, p.provider;
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