import os
import sys

import paramiko


HOST = os.environ.get("SSH_HOST", "192.168.0.135")
USER = os.environ.get("SSH_USER", "root")
PASSWORD = os.environ.get("SSH_PASSWORD", "")


if not PASSWORD:
    raise SystemExit("需要先设置 SSH_PASSWORD 环境变量")


ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASSWORD)
cmd = """docker exec token-monitor-db-1 psql -U monitor -d token_monitor -t -c "SELECT source_app, provider, COUNT(*), MAX(request_at)::text FROM token_usage_logs WHERE request_at > now() - interval '1 day' GROUP BY source_app, provider ORDER BY MAX(request_at) DESC;" """
stdin, stdout, stderr = ssh.exec_command(cmd)
print(stdout.read().decode())
err = stderr.read().decode()
if err:
    print("STDERR:", err, file=sys.stderr)
ssh.close()
