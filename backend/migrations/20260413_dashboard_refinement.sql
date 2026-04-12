-- Dashboard 精细化：用户标记 + 历史 provider 规范化
-- 2026-04-13

BEGIN;

-- 1. User 表增加 is_test 字段
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;

-- 2. 规范化历史 provider 数据（与 canonical.py PROVIDER_ALIASES 一致）
UPDATE token_usage_logs SET provider = 'github-copilot'
WHERE lower(trim(provider)) IN ('github_copilot', 'githubcopilot', 'copilot');

UPDATE token_usage_logs SET provider = 'cursor'
WHERE lower(trim(provider)) = 'cursor' AND provider != 'cursor';

-- 去除多余空格
UPDATE token_usage_logs SET provider = lower(trim(provider))
WHERE provider != lower(trim(provider));

COMMIT;
