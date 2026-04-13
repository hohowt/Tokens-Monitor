-- 历史修正：estimate 来源不应计费
-- 2026-04-13

BEGIN;

UPDATE token_usage_logs
SET cost_usd = 0,
    cost_cny = 0
WHERE source = 'client-mitm-estimate'
  AND (
    COALESCE(cost_usd, 0) <> 0
    OR COALESCE(cost_cny, 0) <> 0
  );

COMMIT;