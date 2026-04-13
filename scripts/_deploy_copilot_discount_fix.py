"""发布 GitHub Copilot 成本折扣修复，并在 135 上重算历史成本。"""

import os
import sys
from pathlib import Path

import paramiko


HOST = os.environ.get("SSH_HOST", "192.168.0.135")
USER = os.environ.get("SSH_USER", "root")
PWD = os.environ.get("SSH_PASSWORD", "")
REMOTE_DIR = "/opt/token-monitor"

ROOT = Path(__file__).resolve().parent.parent
FILES = [
    "backend/app/pricing.py",
    "backend/app/routers/collect.py",
    "backend/scripts/fix_github_copilot_costs.py",
]

COMMANDS = [
    (
        "rebuild backend service",
        f"cd {REMOTE_DIR} && docker compose up -d --build backend",
    ),
    (
        "recalculate github copilot history",
        f"cd {REMOTE_DIR} && cat {REMOTE_DIR}/backend/scripts/fix_github_copilot_costs.py | docker compose exec -T backend sh -lc 'cd /app && python -'",
    ),
    (
        "check backend health",
        "curl -fsS http://127.0.0.1:8000/health",
    ),
    (
        "verify github copilot cost by model",
        f"cd {REMOTE_DIR} && docker compose exec -T db psql -U monitor -d token_monitor -P pager=off -c \""
        "SELECT provider, model_name, COUNT(*) AS rows, ROUND(SUM(total_tokens)::numeric, 0) AS total_tokens, "
        "ROUND(SUM(cost_cny)::numeric, 4) AS cost_cny, "
        "ROUND((SUM(cost_cny) / NULLIF(SUM(total_tokens), 0) * 1000)::numeric, 4) AS cny_per_1k_tokens "
        "FROM token_usage_logs WHERE provider = 'github-copilot' GROUP BY provider, model_name ORDER BY cost_cny DESC;"
        "\"",
    ),
]


def ensure_password() -> None:
    if PWD:
        return
    print("需要: $env:SSH_PASSWORD='...'", file=sys.stderr)
    sys.exit(1)


def connect() -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PWD, timeout=30)
    return client


def upload_files(client: paramiko.SSHClient) -> None:
    transport = client.get_transport()
    if transport is None:
        raise RuntimeError("SSH transport unavailable")

    sftp = paramiko.SFTPClient.from_transport(transport)
    try:
        for rel in FILES:
            local_path = ROOT / rel
            remote_rel = Path(rel).as_posix()
            remote_path = f"{REMOTE_DIR}/{remote_rel}"
            remote_dir = remote_path.rsplit("/", 1)[0]
            client.exec_command(f"mkdir -p {remote_dir}")
            print(f"upload {local_path} -> {remote_path}")
            sftp.put(str(local_path), remote_path)
    finally:
        sftp.close()


def run_command(client: paramiko.SSHClient, label: str, command: str) -> None:
    print("\n" + "=" * 60)
    print(f"[{label}] {command}")
    stdin, stdout, stderr = client.exec_command(command, timeout=1800)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    exit_code = stdout.channel.recv_exit_status()
    if out.strip():
        print(out)
    if err.strip():
        print(err, file=sys.stderr)
    if exit_code != 0:
        raise RuntimeError(f"command failed: {label} (exit={exit_code})")


def main() -> None:
    ensure_password()
    client = connect()
    try:
        upload_files(client)
        for label, command in COMMANDS:
            run_command(client, label, command)
    finally:
        client.close()

    print("\nGitHub Copilot 成本修复发布完成。")


if __name__ == "__main__":
    main()