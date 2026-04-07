SELECT id,
       request_at AT TIME ZONE 'Asia/Shanghai' AS request_cn,
       total_tokens,
       model_name,
       provider,
       source
FROM token_usage_logs
ORDER BY id DESC
LIMIT 20;
