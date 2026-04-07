-- 初始化数据库 schema

-- 部门表
CREATE TABLE departments (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    parent_id INT REFERENCES departments(id),
    budget_monthly BIGINT DEFAULT 0,  -- 月度 Token 预算
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 用户表
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    employee_id VARCHAR(50) NOT NULL UNIQUE,  -- 工号
    name VARCHAR(100) NOT NULL,
    email VARCHAR(200),
    department_id INT REFERENCES departments(id),
    newapi_user_id INT,  -- New API 中的用户 ID
    quota_daily BIGINT DEFAULT 0,   -- 日 Token 配额，0=不限
    quota_monthly BIGINT DEFAULT 0, -- 月 Token 配额
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_users_dept ON users(department_id);
CREATE INDEX idx_users_newapi ON users(newapi_user_id);

-- 项目表
CREATE TABLE projects (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    department_id INT REFERENCES departments(id),
    newapi_channel_id INT,  -- New API 中的渠道 ID
    budget_monthly BIGINT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- AI 模型定价表
CREATE TABLE model_pricing (
    id SERIAL PRIMARY KEY,
    model_name VARCHAR(100) NOT NULL,
    provider VARCHAR(50) NOT NULL,  -- openai, anthropic, google, etc.
    input_price_per_1k NUMERIC(10, 6) NOT NULL,  -- $/1K tokens
    output_price_per_1k NUMERIC(10, 6) NOT NULL,
    effective_from DATE NOT NULL,
    effective_to DATE,
    UNIQUE(model_name, effective_from)
);

-- Token 消耗明细（核心表）
CREATE TABLE token_usage_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id),
    project_id INT REFERENCES projects(id),
    model_name VARCHAR(100) NOT NULL,
    provider VARCHAR(50) NOT NULL,
    source VARCHAR(30) NOT NULL DEFAULT 'gateway',  -- gateway, proxy, billing_api
    source_app VARCHAR(50),
    endpoint VARCHAR(300),
    input_tokens BIGINT NOT NULL DEFAULT 0,
    output_tokens BIGINT NOT NULL DEFAULT 0,
    total_tokens BIGINT NOT NULL DEFAULT 0,
    cost_usd NUMERIC(12, 6) DEFAULT 0,   -- 美元成本
    cost_cny NUMERIC(12, 4) DEFAULT 0,   -- 人民币成本
    request_id VARCHAR(100),
    request_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_usage_user_time ON token_usage_logs(user_id, request_at);
CREATE INDEX idx_usage_project_time ON token_usage_logs(project_id, request_at);
CREATE INDEX idx_usage_model ON token_usage_logs(model_name, request_at);
CREATE INDEX idx_usage_request_at ON token_usage_logs(request_at);
CREATE INDEX idx_usage_source ON token_usage_logs(source);
CREATE INDEX idx_usage_source_app ON token_usage_logs(source_app, request_at);
CREATE INDEX idx_usage_endpoint ON token_usage_logs(endpoint, request_at);

-- 日汇总表（ETL 定时聚合）
CREATE TABLE daily_usage_summary (
    id BIGSERIAL PRIMARY KEY,
    date DATE NOT NULL,
    user_id INT REFERENCES users(id),
    project_id INT REFERENCES projects(id),
    department_id INT REFERENCES departments(id),
    model_name VARCHAR(100),
    provider VARCHAR(50),
    total_requests INT DEFAULT 0,
    input_tokens BIGINT DEFAULT 0,
    output_tokens BIGINT DEFAULT 0,
    total_tokens BIGINT DEFAULT 0,
    cost_usd NUMERIC(12, 6) DEFAULT 0,
    cost_cny NUMERIC(12, 4) DEFAULT 0,
    UNIQUE(date, user_id, project_id, model_name)
);
CREATE INDEX idx_daily_date ON daily_usage_summary(date);
CREATE INDEX idx_daily_user ON daily_usage_summary(user_id, date);
CREATE INDEX idx_daily_dept ON daily_usage_summary(department_id, date);

-- 告警记录表
CREATE TABLE alerts (
    id BIGSERIAL PRIMARY KEY,
    alert_type VARCHAR(50) NOT NULL,  -- quota_exceeded, spike, budget_exceeded
    target_type VARCHAR(20) NOT NULL, -- user, department, project
    target_id INT NOT NULL,
    message TEXT NOT NULL,
    threshold_value BIGINT,
    actual_value BIGINT,
    is_resolved BOOLEAN DEFAULT FALSE,
    notified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_alerts_created ON alerts(created_at);

-- 数据同步状态表
CREATE TABLE sync_state (
    id SERIAL PRIMARY KEY,
    source VARCHAR(50) NOT NULL UNIQUE,  -- newapi, openai_billing, anthropic_billing
    last_sync_at TIMESTAMPTZ,
    last_sync_id VARCHAR(100),  -- 上次同步到的记录 ID
    status VARCHAR(20) DEFAULT 'idle', -- idle, running, error
    error_message TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 客户端注册表
CREATE TABLE clients (
    id SERIAL PRIMARY KEY,
    client_id VARCHAR(100) NOT NULL UNIQUE,
    user_name VARCHAR(100) NOT NULL,
    user_id VARCHAR(50) NOT NULL,
    department VARCHAR(100),
    hostname VARCHAR(100),
    ip_address VARCHAR(50),
    version VARCHAR(20),
    last_seen TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_clients_last_seen ON clients(last_seen);
CREATE INDEX idx_clients_user_id ON clients(user_id);

-- ══════════════════════════════════════════════════════════════
-- 插入默认模型定价（价格单位: $/1K tokens, 截至 2026-04）
-- ══════════════════════════════════════════════════════════════

INSERT INTO model_pricing (model_name, provider, input_price_per_1k, output_price_per_1k, effective_from) VALUES

-- ── OpenAI ──────────────────────────────────────────────────
-- GPT-4o 系列
('gpt-4o', 'openai', 0.0025, 0.01, '2024-05-01'),
('gpt-4o-2024-08-06', 'openai', 0.0025, 0.01, '2024-08-06'),
('gpt-4o-2024-11-20', 'openai', 0.0025, 0.01, '2024-11-20'),
('gpt-4o-mini', 'openai', 0.00015, 0.0006, '2024-07-01'),
('gpt-4o-mini-2024-07-18', 'openai', 0.00015, 0.0006, '2024-07-18'),
('gpt-4o-audio-preview', 'openai', 0.0025, 0.01, '2024-10-01'),
('gpt-4o-realtime-preview', 'openai', 0.005, 0.02, '2024-10-01'),
('chatgpt-4o-latest', 'openai', 0.005, 0.015, '2024-08-01'),
-- GPT-4 系列
('gpt-4-turbo', 'openai', 0.01, 0.03, '2024-04-01'),
('gpt-4-turbo-2024-04-09', 'openai', 0.01, 0.03, '2024-04-09'),
('gpt-4', 'openai', 0.03, 0.06, '2023-03-01'),
('gpt-4-32k', 'openai', 0.06, 0.12, '2023-03-01'),
-- GPT-3.5
('gpt-3.5-turbo', 'openai', 0.0005, 0.0015, '2024-01-01'),
('gpt-3.5-turbo-0125', 'openai', 0.0005, 0.0015, '2024-01-25'),
('gpt-3.5-turbo-16k', 'openai', 0.003, 0.004, '2023-06-01'),
-- o 系列推理模型
('o1', 'openai', 0.015, 0.06, '2024-12-01'),
('o1-2024-12-17', 'openai', 0.015, 0.06, '2024-12-17'),
('o1-mini', 'openai', 0.003, 0.012, '2024-09-01'),
('o1-mini-2024-09-12', 'openai', 0.003, 0.012, '2024-09-12'),
('o1-preview', 'openai', 0.015, 0.06, '2024-09-01'),
('o1-pro', 'openai', 0.15, 0.6, '2025-01-01'),
('o3', 'openai', 0.01, 0.04, '2025-04-01'),
('o3-mini', 'openai', 0.0011, 0.0044, '2025-01-01'),
('o3-mini-2025-01-31', 'openai', 0.0011, 0.0044, '2025-01-31'),
('o4-mini', 'openai', 0.0011, 0.0044, '2025-04-01'),
-- GPT-4.1 系列
('gpt-4.1', 'openai', 0.002, 0.008, '2025-04-01'),
('gpt-4.1-mini', 'openai', 0.0004, 0.0016, '2025-04-01'),
('gpt-4.1-nano', 'openai', 0.0001, 0.0004, '2025-04-01'),
-- Embedding & 其他
('text-embedding-3-large', 'openai', 0.00013, 0, '2024-01-01'),
('text-embedding-3-small', 'openai', 0.00002, 0, '2024-01-01'),
('text-embedding-ada-002', 'openai', 0.0001, 0, '2023-01-01'),
('dall-e-3', 'openai', 0.04, 0, '2023-11-01'),
('tts-1', 'openai', 0.015, 0, '2023-11-01'),
('tts-1-hd', 'openai', 0.03, 0, '2023-11-01'),
('whisper-1', 'openai', 0.006, 0, '2023-01-01'),

-- ── Anthropic (Claude) ──────────────────────────────────────
('claude-3-opus-20240229', 'anthropic', 0.015, 0.075, '2024-02-29'),
('claude-3-sonnet-20240229', 'anthropic', 0.003, 0.015, '2024-02-29'),
('claude-3-haiku-20240307', 'anthropic', 0.00025, 0.00125, '2024-03-07'),
('claude-3-5-sonnet-20240620', 'anthropic', 0.003, 0.015, '2024-06-20'),
('claude-3-5-sonnet-20241022', 'anthropic', 0.003, 0.015, '2024-10-22'),
('claude-3-5-haiku-20241022', 'anthropic', 0.0008, 0.004, '2024-10-22'),
('claude-sonnet-4-20250514', 'anthropic', 0.003, 0.015, '2025-05-14'),
('claude-opus-4-20250918', 'anthropic', 0.015, 0.075, '2025-09-18'),
-- Claude 别名
('claude-3-opus-latest', 'anthropic', 0.015, 0.075, '2024-02-29'),
('claude-3-5-sonnet-latest', 'anthropic', 0.003, 0.015, '2024-10-22'),
('claude-3-5-haiku-latest', 'anthropic', 0.0008, 0.004, '2024-10-22'),
('claude-sonnet-4-latest', 'anthropic', 0.003, 0.015, '2025-05-14'),
('claude-opus-4-latest', 'anthropic', 0.015, 0.075, '2025-09-18'),

-- ── Google (Gemini) ─────────────────────────────────────────
('gemini-1.0-pro', 'google', 0.0005, 0.0015, '2024-01-01'),
('gemini-1.5-pro', 'google', 0.00125, 0.005, '2024-05-01'),
('gemini-1.5-pro-latest', 'google', 0.00125, 0.005, '2024-05-01'),
('gemini-1.5-flash', 'google', 0.000075, 0.0003, '2024-05-01'),
('gemini-1.5-flash-latest', 'google', 0.000075, 0.0003, '2024-05-01'),
('gemini-1.5-flash-8b', 'google', 0.0000375, 0.00015, '2024-10-01'),
('gemini-2.0-flash', 'google', 0.0001, 0.0004, '2025-01-01'),
('gemini-2.0-flash-lite', 'google', 0.000075, 0.0003, '2025-02-01'),
('gemini-2.0-flash-thinking', 'google', 0.0001, 0.0004, '2025-01-01'),
('gemini-2.0-pro', 'google', 0.00125, 0.005, '2025-02-01'),
('gemini-2.5-pro', 'google', 0.00125, 0.01, '2025-03-01'),
('gemini-2.5-flash', 'google', 0.00015, 0.0006, '2025-04-01'),
('gemma-3-27b-it', 'google', 0.00027, 0.00027, '2025-03-01'),
-- Embedding
('text-embedding-004', 'google', 0.000006, 0, '2024-05-01'),

-- ── DeepSeek ────────────────────────────────────────────────
('deepseek-chat', 'deepseek', 0.00014, 0.00028, '2025-01-01'),
('deepseek-reasoner', 'deepseek', 0.00055, 0.00219, '2025-01-01'),
('deepseek-coder', 'deepseek', 0.00014, 0.00028, '2024-06-01'),
('deepseek-v3', 'deepseek', 0.00014, 0.00028, '2025-03-01'),
('deepseek-r1', 'deepseek', 0.00055, 0.00219, '2025-01-01'),

-- ── 阿里云 通义千问 (Qwen) ──────────────────────────────────
('qwen-turbo', 'qwen', 0.00028, 0.00056, '2024-01-01'),
('qwen-turbo-latest', 'qwen', 0.00028, 0.00056, '2024-01-01'),
('qwen-plus', 'qwen', 0.00056, 0.00154, '2024-01-01'),
('qwen-plus-latest', 'qwen', 0.00056, 0.00154, '2024-01-01'),
('qwen-max', 'qwen', 0.00168, 0.0056, '2024-01-01'),
('qwen-max-latest', 'qwen', 0.00168, 0.0056, '2024-01-01'),
('qwen-long', 'qwen', 0.00007, 0.00028, '2024-06-01'),
('qwen-vl-plus', 'qwen', 0.00112, 0.00154, '2024-03-01'),
('qwen-vl-max', 'qwen', 0.0042, 0.0042, '2024-03-01'),
('qwen-coder-plus', 'qwen', 0.0005, 0.0015, '2024-11-01'),
('qwen-coder-turbo', 'qwen', 0.00028, 0.00084, '2024-11-01'),
('qwen2.5-72b-instruct', 'qwen', 0.00056, 0.00154, '2024-09-01'),
('qwen2.5-32b-instruct', 'qwen', 0.00049, 0.00084, '2024-09-01'),
('qwen2.5-14b-instruct', 'qwen', 0.00028, 0.00084, '2024-09-01'),
('qwen2.5-7b-instruct', 'qwen', 0.00014, 0.00028, '2024-09-01'),
('qwen2.5-coder-32b-instruct', 'qwen', 0.00049, 0.00084, '2024-11-01'),
('qwen3-235b-a22b', 'qwen', 0.00056, 0.00154, '2025-04-01'),
('qwen3-32b', 'qwen', 0.00049, 0.00084, '2025-04-01'),
('qwq-32b', 'qwen', 0.00049, 0.00084, '2025-03-01'),
('text-embedding-v3', 'qwen', 0.00001, 0, '2024-09-01'),

-- ── 百度 文心一言 (ERNIE) ───────────────────────────────────
('ernie-4.0-turbo-8k', 'baidu', 0.004, 0.012, '2024-01-01'),
('ernie-4.0-8k', 'baidu', 0.016, 0.016, '2024-01-01'),
('ernie-3.5-128k', 'baidu', 0.0016, 0.0016, '2024-01-01'),
('ernie-3.5-8k', 'baidu', 0.00016, 0.00016, '2024-01-01'),
('ernie-speed-pro-128k', 'baidu', 0.00045, 0.00045, '2024-06-01'),
('ernie-speed-128k', 'baidu', 0, 0, '2024-06-01'),
('ernie-lite-128k', 'baidu', 0, 0, '2024-06-01'),
('ernie-tiny-8k', 'baidu', 0, 0, '2024-06-01'),
('ernie-character-8k', 'baidu', 0.00056, 0.00056, '2024-01-01'),
('ernie-novel-8k', 'baidu', 0.00056, 0.00056, '2024-01-01'),

-- ── 智谱 GLM ────────────────────────────────────────────────
('glm-4-plus', 'zhipu', 0.007, 0.007, '2024-08-01'),
('glm-4-0520', 'zhipu', 0.014, 0.014, '2024-05-20'),
('glm-4', 'zhipu', 0.014, 0.014, '2024-01-01'),
('glm-4-air', 'zhipu', 0.00014, 0.00014, '2024-06-01'),
('glm-4-airx', 'zhipu', 0.0014, 0.0014, '2024-06-01'),
('glm-4-long', 'zhipu', 0.00014, 0.00014, '2024-06-01'),
('glm-4-flash', 'zhipu', 0, 0, '2024-06-01'),
('glm-4-flashx', 'zhipu', 0, 0, '2024-10-01'),
('glm-4v', 'zhipu', 0.007, 0.007, '2024-01-01'),
('glm-4v-plus', 'zhipu', 0.014, 0.014, '2024-08-01'),
('glm-4v-flash', 'zhipu', 0, 0, '2024-10-01'),
('glm-z1-air', 'zhipu', 0.00014, 0.00014, '2025-02-01'),
('glm-z1-airx', 'zhipu', 0.0014, 0.0014, '2025-02-01'),
('glm-z1-flash', 'zhipu', 0, 0, '2025-02-01'),
('embedding-3', 'zhipu', 0.00007, 0, '2024-06-01'),

-- ── Moonshot (月之暗面 / Kimi) ──────────────────────────────
('moonshot-v1-8k', 'moonshot', 0.0017, 0.0017, '2024-03-01'),
('moonshot-v1-32k', 'moonshot', 0.0033, 0.0033, '2024-03-01'),
('moonshot-v1-128k', 'moonshot', 0.0084, 0.0084, '2024-03-01'),
('moonshot-v1-auto', 'moonshot', 0.0017, 0.0017, '2024-06-01'),
('kimi-latest', 'moonshot', 0.0017, 0.0017, '2025-01-01'),

-- ── 零一万物 (Yi) ───────────────────────────────────────────
('yi-lightning', 'yi', 0.00014, 0.00014, '2024-09-01'),
('yi-large', 'yi', 0.0028, 0.0028, '2024-05-01'),
('yi-large-turbo', 'yi', 0.0017, 0.0017, '2024-07-01'),
('yi-medium', 'yi', 0.00035, 0.00035, '2024-03-01'),
('yi-medium-200k', 'yi', 0.0017, 0.0017, '2024-05-01'),
('yi-spark', 'yi', 0.00014, 0.00014, '2024-06-01'),
('yi-vision', 'yi', 0.00084, 0.00084, '2024-05-01'),

-- ── 字节跳动 豆包 (Doubao) ──────────────────────────────────
('doubao-pro-32k', 'doubao', 0.00011, 0.00028, '2024-05-01'),
('doubao-pro-128k', 'doubao', 0.00070, 0.00126, '2024-05-01'),
('doubao-pro-256k', 'doubao', 0.00070, 0.00126, '2024-08-01'),
('doubao-lite-32k', 'doubao', 0.000042, 0.000042, '2024-05-01'),
('doubao-lite-128k', 'doubao', 0.00011, 0.00014, '2024-05-01'),
('doubao-embedding', 'doubao', 0.00007, 0, '2024-05-01'),
('doubao-vision-pro-32k', 'doubao', 0.00014, 0.00028, '2024-08-01'),

-- ── MiniMax (稀宇/海螺) ─────────────────────────────────────
('abab6.5s-chat', 'minimax', 0.0014, 0.0014, '2024-07-01'),
('abab6.5-chat', 'minimax', 0.0042, 0.0042, '2024-01-01'),
('abab6-chat', 'minimax', 0.014, 0.014, '2024-01-01'),
('abab5.5-chat', 'minimax', 0.0021, 0.0021, '2024-01-01'),
('minimax-text-01', 'minimax', 0.00056, 0.00056, '2025-01-01'),

-- ── 讯飞星火 (Spark) ────────────────────────────────────────
('spark-lite', 'spark', 0, 0, '2024-06-01'),
('spark-pro-128k', 'spark', 0.0028, 0.0028, '2024-06-01'),
('spark-max-32k', 'spark', 0.0042, 0.0042, '2024-06-01'),
('spark-4.0-ultra', 'spark', 0.0070, 0.0070, '2024-06-01'),

-- ── 百川 (Baichuan) ─────────────────────────────────────────
('baichuan4', 'baichuan', 0.014, 0.014, '2024-07-01'),
('baichuan3-turbo', 'baichuan', 0.0017, 0.0017, '2024-01-01'),
('baichuan3-turbo-128k', 'baichuan', 0.0024, 0.0024, '2024-06-01'),
('baichuan2-turbo', 'baichuan', 0.0011, 0.0011, '2024-01-01'),

-- ── 腾讯混元 (Hunyuan) ──────────────────────────────────────
('hunyuan-pro', 'hunyuan', 0.0042, 0.0056, '2024-06-01'),
('hunyuan-standard', 'hunyuan', 0.00063, 0.00084, '2024-06-01'),
('hunyuan-standard-256k', 'hunyuan', 0.0021, 0.0028, '2024-06-01'),
('hunyuan-lite', 'hunyuan', 0, 0, '2024-06-01'),
('hunyuan-turbo', 'hunyuan', 0.0021, 0.0028, '2024-09-01'),
('hunyuan-turbo-latest', 'hunyuan', 0.0021, 0.0028, '2025-01-01'),
('hunyuan-role', 'hunyuan', 0.00056, 0.00084, '2024-06-01'),
('hunyuan-vision', 'hunyuan', 0.0025, 0.0025, '2024-09-01'),
('hunyuan-code', 'hunyuan', 0.00056, 0.00084, '2024-06-01'),
('hunyuan-embedding', 'hunyuan', 0.00010, 0, '2024-06-01'),

-- ── Mistral ─────────────────────────────────────────────────
('mistral-large-latest', 'mistral', 0.002, 0.006, '2024-02-01'),
('mistral-large-2411', 'mistral', 0.002, 0.006, '2024-11-01'),
('mistral-medium-latest', 'mistral', 0.0027, 0.0081, '2024-01-01'),
('mistral-small-latest', 'mistral', 0.0002, 0.0006, '2024-09-01'),
('mistral-small-2503', 'mistral', 0.0001, 0.0003, '2025-03-01'),
('codestral-latest', 'mistral', 0.0003, 0.0009, '2024-05-01'),
('codestral-2501', 'mistral', 0.0003, 0.0009, '2025-01-01'),
('mistral-nemo', 'mistral', 0.00015, 0.00015, '2024-07-01'),
('pixtral-large-latest', 'mistral', 0.002, 0.006, '2024-11-01'),
('pixtral-12b-2409', 'mistral', 0.00015, 0.00015, '2024-09-01'),
('mistral-embed', 'mistral', 0.0001, 0, '2024-01-01'),

-- ── Meta Llama (via API providers) ──────────────────────────
('llama-3.3-70b-instruct', 'meta', 0.00027, 0.00027, '2024-12-01'),
('llama-3.2-90b-vision-instruct', 'meta', 0.00027, 0.00027, '2024-09-01'),
('llama-3.2-11b-vision-instruct', 'meta', 0.000055, 0.000055, '2024-09-01'),
('llama-3.2-3b-instruct', 'meta', 0.000015, 0.000015, '2024-09-01'),
('llama-3.2-1b-instruct', 'meta', 0.000010, 0.000010, '2024-09-01'),
('llama-3.1-405b-instruct', 'meta', 0.00053, 0.00053, '2024-07-01'),
('llama-3.1-70b-instruct', 'meta', 0.00027, 0.00027, '2024-07-01'),
('llama-3.1-8b-instruct', 'meta', 0.000055, 0.000055, '2024-07-01'),
('llama-4-scout', 'meta', 0.00015, 0.0006, '2025-04-01'),
('llama-4-maverick', 'meta', 0.0003, 0.00077, '2025-04-01'),

-- ── Cohere ──────────────────────────────────────────────────
('command-r-plus', 'cohere', 0.003, 0.015, '2024-04-01'),
('command-r', 'cohere', 0.0005, 0.0015, '2024-03-01'),
('command-r7b-12-2024', 'cohere', 0.0000375, 0.00015, '2024-12-01'),
('command-a', 'cohere', 0.0025, 0.01, '2025-03-01'),
('embed-english-v3.0', 'cohere', 0.0001, 0, '2023-11-01'),
('embed-multilingual-v3.0', 'cohere', 0.0001, 0, '2023-11-01'),
('rerank-english-v3.0', 'cohere', 0.002, 0, '2024-04-01'),

-- ── xAI (Grok) ──────────────────────────────────────────────
('grok-3', 'xai', 0.003, 0.015, '2025-02-01'),
('grok-3-mini', 'xai', 0.0003, 0.0005, '2025-03-01'),
('grok-2', 'xai', 0.002, 0.01, '2024-08-01'),
('grok-2-mini', 'xai', 0.0002, 0.001, '2024-08-01'),
('grok-2-vision', 'xai', 0.002, 0.01, '2024-12-01'),
('grok-beta', 'xai', 0.005, 0.015, '2024-08-01'),

-- ── Amazon Bedrock (Nova) ───────────────────────────────────
('amazon.nova-pro-v1:0', 'amazon', 0.0008, 0.0032, '2024-12-01'),
('amazon.nova-lite-v1:0', 'amazon', 0.00006, 0.00024, '2024-12-01'),
('amazon.nova-micro-v1:0', 'amazon', 0.000035, 0.00014, '2024-12-01'),
('amazon.titan-text-premier-v1:0', 'amazon', 0.0005, 0.0015, '2024-06-01'),
('amazon.titan-embed-text-v2:0', 'amazon', 0.00002, 0, '2024-04-01'),

-- ── Azure OpenAI (同 OpenAI 定价) ───────────────────────────
('gpt-4o (azure)', 'azure', 0.0025, 0.01, '2024-05-01'),
('gpt-4o-mini (azure)', 'azure', 0.00015, 0.0006, '2024-07-01'),
('gpt-4-turbo (azure)', 'azure', 0.01, 0.03, '2024-04-01'),
('o1 (azure)', 'azure', 0.015, 0.06, '2024-12-01'),
('o3-mini (azure)', 'azure', 0.0011, 0.0044, '2025-01-01'),

-- ── 商汤 SenseChat ──────────────────────────────────────────
('sensechat-5', 'sensetime', 0.007, 0.007, '2024-06-01'),
('sensechat-5-vision', 'sensetime', 0.007, 0.007, '2024-09-01'),
('sensechat-turbo', 'sensetime', 0.0006, 0.0008, '2024-06-01'),
('sensechat-lite', 'sensetime', 0, 0, '2024-06-01'),

-- ── 昆仑万维 天工 (SkyWork) ─────────────────────────────────
('skywork-o1-open', 'skywork', 0.00042, 0.00042, '2024-11-01'),

-- ── 阶跃星辰 (StepFun) ─────────────────────────────────────
('step-1-128k', 'stepfun', 0.006, 0.018, '2024-04-01'),
('step-1-32k', 'stepfun', 0.0021, 0.007, '2024-04-01'),
('step-2-16k', 'stepfun', 0.0054, 0.019, '2024-09-01'),
('step-1-flash', 'stepfun', 0.00014, 0.00056, '2024-09-01'),
('step-1v-8k', 'stepfun', 0.006, 0.018, '2024-04-01'),
('step-1.5v-mini', 'stepfun', 0.0011, 0.004, '2024-09-01'),

-- ── Perplexity ──────────────────────────────────────────────
('sonar-pro', 'perplexity', 0.003, 0.015, '2025-01-01'),
('sonar', 'perplexity', 0.001, 0.001, '2025-01-01'),
('sonar-reasoning-pro', 'perplexity', 0.003, 0.015, '2025-02-01'),
('sonar-reasoning', 'perplexity', 0.001, 0.005, '2025-02-01'),
('sonar-deep-research', 'perplexity', 0.003, 0.015, '2025-02-01'),

-- ── Together AI (托管开源模型) ───────────────────────────────
('Qwen/QwQ-32B', 'together', 0.0003, 0.0003, '2025-03-01'),
('deepseek-ai/DeepSeek-R1', 'together', 0.003, 0.007, '2025-02-01'),
('meta-llama/Llama-3.3-70B-Instruct-Turbo', 'together', 0.00054, 0.00054, '2024-12-01'),
('meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo', 'together', 0.0035, 0.0035, '2024-07-01'),

-- ── Groq (超快推理) ─────────────────────────────────────────
('llama-3.3-70b-versatile', 'groq', 0.00059, 0.00079, '2024-12-01'),
('llama-3.1-8b-instant', 'groq', 0.00005, 0.00008, '2024-07-01'),
('gemma2-9b-it', 'groq', 0.0002, 0.0002, '2024-06-01'),
('mixtral-8x7b-32768', 'groq', 0.00024, 0.00024, '2024-01-01'),
('deepseek-r1-distill-llama-70b', 'groq', 0.00075, 0.00099, '2025-02-01')
;
