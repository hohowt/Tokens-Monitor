ALTER TABLE token_usage_logs
ADD COLUMN IF NOT EXISTS source_app VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_usage_source_app
ON token_usage_logs(source_app, request_at);