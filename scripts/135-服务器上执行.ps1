# 在 192.168.0.135 上，进入包含 docker-compose.yml 的目录后执行（需已同步最新代码）。
# 本机无法替你 SSH 登录 135，以下命令请在服务器上复制运行。

Write-Host @"
=== 1) 重建并重启后端/前端（使大屏时区等新代码生效）===
docker compose up -d --build backend frontend

=== 2) 查库：最近 20 条（密码见 compose / .env 的 DB_PASSWORD）===
docker compose exec -T db psql -U monitor -d token_monitor -c "SELECT id, request_at AT TIME ZONE 'Asia/Shanghai' AS cn, total_tokens, model_name, provider, source FROM token_usage_logs ORDER BY id DESC LIMIT 20;"

也可使用仓库内 scripts/query-latest-logs.sql 的内容粘贴到 psql 执行。
"@
