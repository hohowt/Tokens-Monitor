from __future__ import annotations

import os
from pathlib import Path

import paramiko


HOST = "192.168.0.135"
USERNAME = "root"
REMOTE_SCRIPT = "/opt/token-monitor/backend/scripts/fix_github_copilot_costs.py"


def run_command(client: paramiko.SSHClient, command: str, timeout: int = 1800) -> str:
    print(f"\n=== {command}")
    stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
    output = stdout.read().decode("utf-8", "replace")
    error = stderr.read().decode("utf-8", "replace")
    if output:
        print(output)
    if error:
        print(error)
    exit_code = stdout.channel.recv_exit_status()
    print(f"exit={exit_code}")
    if exit_code != 0:
        raise SystemExit(exit_code)
    return output


def main() -> None:
    password = os.environ.get("SSH_PASSWORD")
    if not password:
        raise SystemExit("SSH_PASSWORD is required")

    local_script = Path(__file__).resolve().parent.parent / "backend" / "scripts" / "fix_github_copilot_costs.py"

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USERNAME, password=password, timeout=30)
    try:
        sftp = paramiko.SFTPClient.from_transport(client.get_transport())
        try:
            run_command(client, "mkdir -p /opt/token-monitor/backend/scripts")
            sftp.put(str(local_script), REMOTE_SCRIPT)
            print(f"uploaded {local_script} -> {REMOTE_SCRIPT}")
        finally:
            sftp.close()

        run_command(
            client,
            "cd /opt/token-monitor && cat /opt/token-monitor/backend/scripts/fix_github_copilot_costs.py | docker compose exec -T backend sh -lc 'cd /app && python -'",
            timeout=3600,
        )
        run_command(client, "curl -fsS http://127.0.0.1:8000/health")
        run_command(
            client,
            "cd /opt/token-monitor && docker compose exec -T db psql -U monitor -d token_monitor -P pager=off -c \"SELECT provider, model_name, COUNT(*) AS rows, ROUND(SUM(total_tokens)::numeric, 0) AS total_tokens, ROUND(SUM(cost_cny)::numeric, 4) AS cost_cny, ROUND((SUM(cost_cny) / NULLIF(SUM(total_tokens), 0) * 1000)::numeric, 4) AS cny_per_1k_tokens FROM token_usage_logs WHERE provider = 'github-copilot' GROUP BY provider, model_name ORDER BY cost_cny DESC;\"",
        )
    finally:
        client.close()


if __name__ == "__main__":
    main()