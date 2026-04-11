"""
统一远程部署脚本 - 支持多种部署场景
Usage: python scripts/deploy.py [action] [options]

Actions:
    all         完整部署（检查→上传→构建→启动→迁移）
    check       仅检查服务器环境
    upload      仅上传文件
    build       仅构建镜像
    start       仅启动服务
    migrate     执行增量数据库迁移（不重启服务）
    status      查看服务状态
    logs        查看日志
    stop        停止服务

Options:
    --host      服务器地址（默认从环境变量 SSH_HOST 读取）
    --user      SSH用户名（默认从环境变量 SSH_USER 读取）
    --mirror    使用镜像（如：swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io）

Environment Variables:
    SSH_HOST    服务器地址（默认: 192.168.0.135）
    SSH_USER    SSH用户名（默认: root）
    SSH_PASS    SSH密码（必须设置）
"""

import os
import sys
import time
import argparse
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

try:
    import paramiko
except ImportError:
    print("Installing paramiko...")
    os.system(f"{sys.executable} -m pip install paramiko")
    import paramiko


class Deployer:
    """Unified deployment manager."""
    
    DEFAULT_HOST = "192.168.0.135"
    DEFAULT_USER = "root"
    REMOTE_DIR = "/opt/token-monitor"
    
    def __init__(self, host=None, user=None, password=None, mirror=None):
        self.host = host or os.environ.get("SSH_HOST", self.DEFAULT_HOST)
        self.user = user or os.environ.get("SSH_USER", self.DEFAULT_USER)
        self.password = password or os.environ.get("SSH_PASS", "")
        self.mirror = mirror or os.environ.get("DOCKER_MIRROR", "")
        
        if not self.password:
            raise ValueError("SSH password required. Set SSH_PASS environment variable.")
        
        self.ssh = None
        self.sftp = None
    
    def connect(self):
        """Connect to remote server."""
        print(f"Connecting to {self.host}...")
        self.ssh = paramiko.SSHClient()
        self.ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        self.ssh.connect(self.host, username=self.user, password=self.password, timeout=30)
        self.sftp = self.ssh.open_sftp()
        print("  ✓ Connected")
    
    def run(self, cmd, timeout=120, print_output=True):
        """Execute command on remote server."""
        if print_output:
            print(f"  $ {cmd[:80]}{'...' if len(cmd) > 80 else ''}")
        
        stdin, stdout, stderr = self.ssh.exec_command(cmd, timeout=timeout)
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        code = stdout.channel.recv_exit_status()
        
        if print_output:
            if out.strip():
                for line in out.strip().split("\n")[:30]:
                    print(f"    {line}")
            if err.strip() and "WARNING" not in err.upper():
                for line in err.strip().split("\n")[:10]:
                    print(f"    [err] {line}")
        
        return out, err, code
    
    def upload_file(self, local_rel, remote_rel=None):
        """Upload a single file."""
        if remote_rel is None:
            remote_rel = local_rel
        
        local_path = project_root / local_rel.replace("/", os.sep)
        remote_path = f"{self.REMOTE_DIR}/{remote_rel}"
        
        if not local_path.exists():
            print(f"  ⚠ Skip (not found): {local_rel}")
            return
        
        # Ensure remote directory exists
        remote_dir = "/".join(remote_path.split("/")[:-1])
        self.run(f"mkdir -p {remote_dir}", print_output=False)
        
        self.sftp.put(str(local_path), remote_path)
        print(f"    ↑ {remote_rel}")
    
    def upload_dir(self, local_dir, remote_dir=None, exclude=None):
        """Upload entire directory."""
        if remote_dir is None:
            remote_dir = f"{self.REMOTE_DIR}/{local_dir}"
        
        local_path = project_root / local_dir
        exclude = exclude or {".git", "node_modules", "__pycache__", ".venv", "venv", 
                              "dist", "*.pyc", "ai-monitor.exe", ".env", "pgdata"}
        
        self.run(f"mkdir -p {remote_dir}", print_output=False)
        
        for item in local_path.rglob("*"):
            # Check exclusion patterns
            rel_path = item.relative_to(local_path)
            if any(ex in str(rel_path) for ex in exclude):
                continue
            
            if item.is_file():
                remote_file = f"{remote_dir}/{rel_path.as_posix()}"
                remote_parent = "/".join(remote_file.split("/")[:-1])
                self.run(f"mkdir -p {remote_parent}", print_output=False)
                self.sftp.put(str(item), remote_file)
                print(f"    ↑ {local_dir}/{rel_path}")
    
    def check_environment(self):
        """Check server environment."""
        print("\n=== 1. Environment Check ===")
        
        # Check OS
        self.run("cat /etc/os-release | head -5")
        
        # Check Docker
        _, _, code = self.run("docker --version")
        if code != 0:
            print("  ⚠ Docker not installed")
            return False
        
        _, _, code = self.run("docker compose version || docker-compose version")
        if code != 0:
            print("  ⚠ Docker Compose not installed")
            return False
        
        # Check ports
        self.run("ss -tlnp | grep -E ':80 |:8000 |:9000 |:5432 |:6379 ' || echo 'No port conflicts'")
        
        # Check resources
        self.run("df -h / | tail -1")
        self.run("free -h | head -2")
        
        print("  ✓ Environment check passed")
        return True
    
    def upload_project(self):
        """Upload project files."""
        print("\n=== 2. Upload Project Files ===")

        # Backend — 整目录上传，Docker COPY . . 需要完整文件
        self.upload_dir(
            "backend",
            f"{self.REMOTE_DIR}/backend",
            exclude={".git", "__pycache__", ".venv", "venv", "*.pyc", ".env", "pgdata"},
        )

        # Frontend — 整目录上传，Docker build 需要完整文件
        self.upload_dir(
            "frontend",
            f"{self.REMOTE_DIR}/frontend",
            exclude={".git", "node_modules", "dist"},
        )

        # Deploy configs
        self.upload_file("docker-compose.yml")
        self.upload_file("deploy/k8s.yaml")

        print("  ✓ Upload complete")
    
    def generate_env(self):
        """Generate environment configuration."""
        print("\n=== 3. Generate Configuration ===")

        db_password = os.environ.get("DB_PASSWORD", "AiMon!2026Secure")
        collect_api_key = os.environ.get("COLLECT_API_KEY", "CHANGE_ME_GENERATE_A_STRONG_KEY")
        admin_password = os.environ.get("ADMIN_PASSWORD", "CHANGE_ME_GENERATE_A_STRONG_PASSWORD")
        cors_origins = os.environ.get("CORS_ALLOWED_ORIGINS", f"http://{self.host}:3080")

        env_content = f"""DATABASE_URL=postgresql+asyncpg://monitor:{db_password}@db:5432/token_monitor
REDIS_URL=redis://redis:6379/0
COLLECT_API_KEY={collect_api_key}
ADMIN_PASSWORD={admin_password}
CORS_ALLOWED_ORIGINS={cors_origins}
NEWAPI_BASE_URL={os.environ.get('NEWAPI_BASE_URL', '')}
NEWAPI_ADMIN_TOKEN={os.environ.get('NEWAPI_ADMIN_TOKEN', '')}
USD_TO_CNY=7.25
ALERT_WEBHOOK_URL={os.environ.get('ALERT_WEBHOOK_URL', '')}
SYNC_INTERVAL_MINUTES=10
"""

        # Warn if using placeholder values
        if "CHANGE_ME" in collect_api_key:
            print("  ⚠ COLLECT_API_KEY 使用占位符，请设置 COLLECT_API_KEY 环境变量")
        if "CHANGE_ME" in admin_password:
            print("  ⚠ ADMIN_PASSWORD 使用占位符，请设置 ADMIN_PASSWORD 环境变量")

        # Write to remote
        self.run(f"cat > {self.REMOTE_DIR}/backend/.env << 'EOF'\n{env_content}EOF", print_output=False)
        print("  ✓ Generated backend/.env")
    
    def build_and_start(self):
        """Build and start services."""
        print("\n=== 4. Build & Deploy ===")
        
        # Stop existing
        self.run(f"cd {self.REMOTE_DIR} && docker compose down 2>/dev/null || true", 
                 print_output=False, timeout=60)
        
        # Build
        print("  Building images...")
        _, err, code = self.run(f"cd {self.REMOTE_DIR} && docker compose build --no-cache 2>&1 | tail -30", 
                               timeout=600)
        if code != 0:
            print(f"  ✗ Build failed!")
            return False
        
        # Start
        print("  Starting services...")
        self.run(f"cd {self.REMOTE_DIR} && docker compose up -d 2>&1", timeout=120)
        
        # Wait for health
        print("  Waiting for services...")
        for i in range(18):
            time.sleep(10)
            out, _, _ = self.run("curl -sf http://localhost:8000/health 2>/dev/null || echo 'NOT_READY'", 
                                print_output=False)
            if "ok" in out:
                print(f"  ✓ Services ready (after {(i+1)*10}s)")
                return True
            print(f"    ({i+1}/18) waiting...")
        
        print("  ⚠ Services may not be fully ready")
        return False
    
    def status(self):
        """Check service status."""
        print("\n=== Service Status ===")
        self.run(f"cd {self.REMOTE_DIR} && docker compose ps")
        self.run("curl -s http://localhost:8000/health 2>/dev/null || echo 'Backend not ready'")
    
    def logs(self, tail=50):
        """View service logs."""
        print(f"\n=== Service Logs (last {tail} lines) ===")
        self.run(f"cd {self.REMOTE_DIR} && docker compose logs --tail={tail}")
    
    def stop(self):
        """Stop services."""
        print("\n=== Stopping Services ===")
        self.run(f"cd {self.REMOTE_DIR} && docker compose down")
        print("  ✓ Services stopped")

    def run_migration(self):
        """Run incremental database migrations."""
        print("\n=== Database Migration ===")

        migration_dir = project_root / "backend" / "migrations"
        migration_files = sorted(
            f for f in migration_dir.glob("*.sql")
            if f.name != "init.sql"
        )

        if not migration_files:
            print("  No migration files found (excluding init.sql)")
            return

        remote_migration_dir = f"{self.REMOTE_DIR}/backend/migrations"
        self.run(f"mkdir -p {remote_migration_dir}", print_output=False)

        for mf in migration_files:
            remote_path = f"{remote_migration_dir}/{mf.name}"
            self.sftp.put(str(mf), remote_path)
            print(f"  ↑ {mf.name}")

            # CONCURRENTLY 索引不能在事务内创建，用 psql 通过 stdin 执行
            print(f"  Executing {mf.name} ...")
            out, err, code = self.run(
                f"cd {self.REMOTE_DIR} && docker compose exec -T db "
                f"psql -U monitor -d token_monitor --set ON_ERROR_STOP=1 "
                f"< {remote_path}",
                timeout=300,
            )
            if code != 0:
                # CONCURRENTLY 索引在已存在时会报 notice 但不会失败（IF NOT EXISTS）
                if "already exists" in (out + err).lower():
                    print(f"  ✓ {mf.name} (indexes already exist, skipped)")
                else:
                    print(f"  ⚠ {mf.name} returned exit code {code}")
            else:
                print(f"  ✓ {mf.name} applied")

        print("  ✓ Migration complete")
    
    def close(self):
        """Close connections."""
        if self.sftp:
            self.sftp.close()
        if self.ssh:
            self.ssh.close()
    
    def run_all(self):
        """Run full deployment."""
        try:
            self.connect()
            
            if not self.check_environment():
                print("\n✗ Environment check failed")
                return 1
            
            self.upload_project()
            self.generate_env()
            
            if not self.build_and_start():
                print("\n✗ Deployment failed")
                return 1

            self.run_migration()
            self.status()
            
            print("\n" + "="*50)
            print("✅ Deployment Complete!")
            print(f"  Dashboard: http://{self.host}:3080")
            print(f"  API:       http://{self.host}:8000")
            print("="*50)
            
            return 0
            
        except Exception as e:
            print(f"\n✗ Error: {e}")
            return 1
        finally:
            self.close()


def main():
    parser = argparse.ArgumentParser(description="AI Token Monitor Deployment")
    parser.add_argument("action", choices=["all", "check", "upload", "build", "start", "status", "logs", "stop", "migrate"],
                       default="all", nargs="?", help="Action to perform")
    parser.add_argument("--host", help="Server host (or SSH_HOST env)")
    parser.add_argument("--user", help="SSH user (or SSH_USER env)")
    parser.add_argument("--mirror", help="Docker mirror (or DOCKER_MIRROR env)")
    parser.add_argument("--tail", type=int, default=50, help="Log tail lines")
    
    args = parser.parse_args()
    
    try:
        deployer = Deployer(host=args.host, user=args.user, mirror=args.mirror)
        
        if args.action == "all":
            return deployer.run_all()
        
        deployer.connect()
        
        if args.action == "check":
            deployer.check_environment()
        elif args.action == "upload":
            deployer.upload_project()
            deployer.generate_env()
        elif args.action == "build":
            deployer.build_and_start()
        elif args.action == "start":
            deployer.run(f"cd {deployer.REMOTE_DIR} && docker compose up -d")
        elif args.action == "status":
            deployer.status()
        elif args.action == "logs":
            deployer.logs(args.tail)
        elif args.action == "stop":
            deployer.stop()
        elif args.action == "migrate":
            deployer.run_migration()
        
        deployer.close()
        return 0
        
    except Exception as e:
        print(f"\n✗ Error: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
