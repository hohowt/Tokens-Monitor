"""将本仓库 backend 关键文件上传到 135 /opt/token-monitor/backend/"""
import os
import sys

import paramiko

HOST = os.environ.get("SSH_HOST", "192.168.0.135")
USER = os.environ.get("SSH_USER", "root")
PWD = os.environ.get("SSH_PASSWORD", "")
REMOTE_BASE = "/opt/token-monitor/backend"

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))
FILES = [
    "backend/app/config.py",
    "backend/app/routers/dashboard.py",
    "backend/app/routers/collect.py",
    "backend/app/services/aggregator.py",
]

if not PWD:
    print("需要 SSH_PASSWORD", file=sys.stderr)
    sys.exit(1)


def main():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, password=PWD, timeout=25)
    c.exec_command("mkdir -p /opt/token-monitor/backend/app/routers /opt/token-monitor/backend/app/services")
    t = c.get_transport()
    sftp = paramiko.SFTPClient.from_transport(t)
    for rel in FILES:
        local = os.path.join(ROOT, rel.replace("/", os.sep))
        remote = REMOTE_BASE + "/" + rel.replace("backend/", "", 1).replace("\\", "/")
        print("upload", local, "->", remote)
        sftp.put(local, remote)
    sftp.close()
    c.close()
    print("上传完成。")


if __name__ == "__main__":
    main()
