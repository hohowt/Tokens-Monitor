"""上传估算成本修复相关文件，并在 135 上执行最小发布。"""

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
    "backend/app/routers/dashboard.py",
    "backend/scripts/fix_estimate_costs.py",
    "backend/migrations/20260413_zero_estimate_costs.sql",
]

REBUILD_SUMMARIES_COMMAND = """cd {remote_dir} && docker compose exec -T backend sh -lc 'python - <<"PY"
import asyncio
from datetime import date
from sqlalchemy import Date, cast, func, select
from app.config import settings
from app.database import async_session
from app.models import TokenUsageLog
from app.services.aggregator import aggregate_daily

ESTIMATE_SOURCE = "client-mitm-estimate"

async def main():
    local_day = cast(func.timezone(settings.DASHBOARD_TIMEZONE, TokenUsageLog.request_at), Date)
    async with async_session() as db:
        result = await db.execute(
            select(local_day)
            .where(TokenUsageLog.source == ESTIMATE_SOURCE)
            .distinct()
            .order_by(local_day)
        )
        affected_dates = [row[0] for row in result.all() if isinstance(row[0], date)]
    for day in affected_dates:
        await aggregate_daily(day)
    print(f"rebuilt daily summaries days={{len(affected_dates)}}")

asyncio.run(main())
PY'""".format(remote_dir=REMOTE_DIR)

COMMANDS = [
    (
        "apply sql migration",
        f"cd {REMOTE_DIR} && cat {REMOTE_DIR}/backend/migrations/20260413_zero_estimate_costs.sql | "
        f"docker compose exec -T db psql -U monitor -d token_monitor",
    ),
    (
        "rebuild backend service",
        f"cd {REMOTE_DIR} && docker compose up -d --build backend",
    ),
    (
        "rebuild affected summaries",
        REBUILD_SUMMARIES_COMMAND,
    ),
    (
        "check backend health",
        "curl -fsS http://127.0.0.1:8000/health",
    ),
    (
        "verify estimate rows are non-billable",
        f"cd {REMOTE_DIR} && docker compose exec -T db psql -U monitor -d token_monitor -c \""
        "SELECT COUNT(*) AS remaining_nonzero_estimate_cost_rows "
        "FROM token_usage_logs "
        "WHERE source = 'client-mitm-estimate' "
        "AND (COALESCE(cost_usd, 0) <> 0 OR COALESCE(cost_cny, 0) <> 0);"
        "\"",
    ),
    (
        "verify estimate total cost",
        f"cd {REMOTE_DIR} && docker compose exec -T db psql -U monitor -d token_monitor -c \""
        "SELECT COUNT(*) AS estimate_rows, COALESCE(SUM(cost_cny), 0) AS estimate_total_cost_cny "
        "FROM token_usage_logs "
        "WHERE source = 'client-mitm-estimate';"
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

    print("\n修复发布完成。")


if __name__ == "__main__":
    main()