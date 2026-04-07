ALTER TABLE token_usage_logs
ADD COLUMN IF NOT EXISTS endpoint VARCHAR(300);

CREATE INDEX IF NOT EXISTS idx_usage_endpoint
ON token_usage_logs(endpoint, request_at);