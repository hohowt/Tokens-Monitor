ALTER TABLE token_usage_logs
ADD COLUMN IF NOT EXISTS request_count INT NOT NULL DEFAULT 1;

UPDATE token_usage_logs
SET request_count = 1
WHERE request_count IS NULL;