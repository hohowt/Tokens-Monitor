from datetime import date, datetime

from pydantic import BaseModel


# === Overview ===
class OverviewResponse(BaseModel):
    total_tokens: int
    total_cost_cny: float
    total_requests: int
    active_users: int
    avg_tokens_per_user: int
    avg_cost_per_user: float
    exact_tokens: int = 0
    estimated_tokens: int = 0
    exact_requests: int = 0
    estimated_requests: int = 0
    # 环比
    tokens_change_pct: float | None = None
    cost_change_pct: float | None = None


# === Trend ===
class TrendPoint(BaseModel):
    date: str
    total_tokens: int
    input_tokens: int
    output_tokens: int
    cost_cny: float
    requests: int


class TrendResponse(BaseModel):
    points: list[TrendPoint]
    avg_tokens: int
    avg_cost: float


# === Ranking ===
class RankingItem(BaseModel):
    id: int
    name: str
    total_tokens: int
    cost_cny: float
    requests: int


class RankingResponse(BaseModel):
    items: list[RankingItem]


# === Model / Provider breakdown ===
class BreakdownItem(BaseModel):
    key: str | None = None
    name: str
    total_tokens: int
    cost_cny: float
    percentage: float


class BreakdownResponse(BaseModel):
    items: list[BreakdownItem]


# === Alerts ===
class AlertItem(BaseModel):
    id: int
    alert_type: str
    target_type: str
    target_name: str
    message: str
    actual_value: int | None
    threshold_value: int | None
    created_at: datetime


class AlertListResponse(BaseModel):
    items: list[AlertItem]
    total: int


# === Detail logs ===
class UsageLogItem(BaseModel):
    id: int
    user_name: str
    model_name: str
    provider: str
    endpoint: str | None = None
    input_tokens: int
    output_tokens: int
    total_tokens: int
    cost_cny: float
    request_at: datetime


class UsageLogResponse(BaseModel):
    items: list[UsageLogItem]
    total: int


# === Query params ===
class DateRangeParams(BaseModel):
    start_date: date | None = None
    end_date: date | None = None
    days: int = 15  # 默认近 15 天


# === Tokscale submit payload ===
class TokscaleDateRange(BaseModel):
    start: str
    end: str


class TokscaleTokenBreakdown(BaseModel):
    input: int = 0
    output: int = 0
    cacheRead: int = 0
    cacheWrite: int = 0
    reasoning: int = 0


class TokscaleDailyTotals(BaseModel):
    tokens: int = 0
    cost: float = 0.0
    messages: int = 0


class TokscaleClientContribution(BaseModel):
    client: str
    modelId: str
    providerId: str | None = None
    tokens: TokscaleTokenBreakdown
    cost: float = 0.0
    messages: int = 0


class TokscaleDailyContribution(BaseModel):
    date: str
    timestampMs: int | None = None
    totals: TokscaleDailyTotals
    intensity: int = 0
    tokenBreakdown: TokscaleTokenBreakdown
    clients: list[TokscaleClientContribution] = []


class TokscaleYearSummary(BaseModel):
    year: str
    totalTokens: int = 0
    totalCost: float = 0.0
    range: TokscaleDateRange


class TokscaleDataSummary(BaseModel):
    totalTokens: int = 0
    totalCost: float = 0.0
    totalDays: int = 0
    activeDays: int = 0
    averagePerDay: float = 0.0
    maxCostInSingleDay: float = 0.0
    clients: list[str] = []
    models: list[str] = []


class TokscaleExportMeta(BaseModel):
    generatedAt: str
    version: str
    dateRange: TokscaleDateRange


class TokscaleContributionPayload(BaseModel):
    meta: TokscaleExportMeta
    summary: TokscaleDataSummary
    years: list[TokscaleYearSummary] = []
    contributions: list[TokscaleDailyContribution] = []


class TokscaleSubmitRequest(BaseModel):
    client_id: str
    user_name: str
    user_id: str
    department: str | None = None
    hostname: str | None = None
    version: str | None = None
    payload: TokscaleContributionPayload
