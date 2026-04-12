-- 用户认证字段 + 自动编号序列
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(128);
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_token VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_token_created_at TIMESTAMPTZ;

-- auth_token 查询索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_auth_token
    ON users (auth_token) WHERE auth_token IS NOT NULL;

-- 自增工号序列，起始值取现有最大数字工号 + 1（至少 10001）
DO $$
DECLARE
    max_id INT;
BEGIN
    -- 仅在序列不存在时创建
    IF NOT EXISTS (SELECT 1 FROM pg_sequences WHERE schemaname = 'public' AND sequencename = 'employee_id_seq') THEN
        SELECT COALESCE(MAX(employee_id::INT), 10000) INTO max_id
        FROM users
        WHERE employee_id ~ '^\d+$';
        EXECUTE format('CREATE SEQUENCE employee_id_seq START WITH %s', max_id + 1);
    END IF;
END $$;
