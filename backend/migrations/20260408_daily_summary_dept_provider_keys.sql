-- 明细：写入时记录部门快照；日汇总：按 provider + 部门键 + 项目键 唯一，避免覆盖。
-- 执行后 daily_usage_summary 已清空，请运行: python scripts/rebuild_daily_summary.py

BEGIN;

ALTER TABLE token_usage_logs
    ADD COLUMN IF NOT EXISTS department_id INT REFERENCES departments(id) ON DELETE SET NULL;

UPDATE token_usage_logs l
SET department_id = u.department_id
FROM users u
WHERE l.user_id = u.id
  AND l.department_id IS NULL;

ALTER TABLE daily_usage_summary DROP CONSTRAINT IF EXISTS daily_usage_summary_date_user_id_project_id_model_name_key;

ALTER TABLE daily_usage_summary ADD COLUMN IF NOT EXISTS proj_key INT NOT NULL DEFAULT -1;
ALTER TABLE daily_usage_summary ADD COLUMN IF NOT EXISTS dept_key INT NOT NULL DEFAULT -1;

UPDATE daily_usage_summary SET provider = COALESCE(provider, '');
UPDATE daily_usage_summary SET model_name = COALESCE(model_name, '');

ALTER TABLE daily_usage_summary ALTER COLUMN provider SET NOT NULL;
ALTER TABLE daily_usage_summary ALTER COLUMN model_name SET NOT NULL;

TRUNCATE TABLE daily_usage_summary;

CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_usage_summary_key
    ON daily_usage_summary (date, user_id, proj_key, model_name, provider, dept_key);

COMMIT;
