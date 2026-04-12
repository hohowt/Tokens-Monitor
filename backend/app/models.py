from datetime import datetime, timezone

from sqlalchemy import BigInteger, Boolean, Date, DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Department(Base):
    __tablename__ = "departments"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("departments.id"))
    budget_monthly: Mapped[int] = mapped_column(BigInteger, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    employee_id: Mapped[str] = mapped_column(String(50), unique=True)
    name: Mapped[str] = mapped_column(String(100))
    email: Mapped[str | None] = mapped_column(String(200))
    department_id: Mapped[int | None] = mapped_column(ForeignKey("departments.id"))
    newapi_user_id: Mapped[int | None] = mapped_column(Integer)
    quota_daily: Mapped[int] = mapped_column(BigInteger, default=0)
    quota_monthly: Mapped[int] = mapped_column(BigInteger, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    # 认证字段
    password_hash: Mapped[str | None] = mapped_column(String(128))
    auth_token: Mapped[str | None] = mapped_column(String(64))
    auth_token_created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    department_id: Mapped[int | None] = mapped_column(ForeignKey("departments.id"))
    newapi_channel_id: Mapped[int | None] = mapped_column(Integer)
    budget_monthly: Mapped[int] = mapped_column(BigInteger, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class ModelPricing(Base):
    __tablename__ = "model_pricing"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    model_name: Mapped[str] = mapped_column(String(100))
    provider: Mapped[str] = mapped_column(String(50))
    input_price_per_1k: Mapped[float] = mapped_column(Numeric(10, 6))
    output_price_per_1k: Mapped[float] = mapped_column(Numeric(10, 6))
    effective_from: Mapped[datetime] = mapped_column(Date)
    effective_to: Mapped[datetime | None] = mapped_column(Date)


class TokenUsageLog(Base):
    __tablename__ = "token_usage_logs"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id"))
    department_id: Mapped[int | None] = mapped_column(ForeignKey("departments.id", ondelete="SET NULL"))
    model_name: Mapped[str] = mapped_column(String(100))
    provider: Mapped[str] = mapped_column(String(50))
    source: Mapped[str] = mapped_column(String(30), default="gateway")
    source_app: Mapped[str | None] = mapped_column(String(50))
    endpoint: Mapped[str | None] = mapped_column(String(300))
    input_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    output_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    total_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    request_count: Mapped[int] = mapped_column(Integer, default=1)
    cost_usd: Mapped[float] = mapped_column(Numeric(12, 6), default=0)
    cost_cny: Mapped[float] = mapped_column(Numeric(12, 4), default=0)
    request_id: Mapped[str | None] = mapped_column(String(100))
    request_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class DailyUsageSummary(Base):
    __tablename__ = "daily_usage_summary"
    __table_args__ = (
        UniqueConstraint(
            "date",
            "user_id",
            "proj_key",
            "model_name",
            "provider",
            "dept_key",
            name="uq_daily_usage_summary_key",
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    date: Mapped[datetime] = mapped_column(Date)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id"))
    proj_key: Mapped[int] = mapped_column(Integer, default=-1, nullable=False)
    department_id: Mapped[int | None] = mapped_column(ForeignKey("departments.id"))
    dept_key: Mapped[int] = mapped_column(Integer, default=-1, nullable=False)
    model_name: Mapped[str] = mapped_column(String(100), default="")
    provider: Mapped[str] = mapped_column(String(50), default="")
    total_requests: Mapped[int] = mapped_column(Integer, default=0)
    input_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    output_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    total_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    cost_usd: Mapped[float] = mapped_column(Numeric(12, 6), default=0)
    cost_cny: Mapped[float] = mapped_column(Numeric(12, 4), default=0)


class Alert(Base):
    __tablename__ = "alerts"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    alert_type: Mapped[str] = mapped_column(String(50))
    target_type: Mapped[str] = mapped_column(String(20))
    target_id: Mapped[int] = mapped_column(Integer)
    message: Mapped[str] = mapped_column(Text)
    threshold_value: Mapped[int | None] = mapped_column(BigInteger)
    actual_value: Mapped[int | None] = mapped_column(BigInteger)
    is_resolved: Mapped[bool] = mapped_column(Boolean, default=False)
    notified_at: Mapped[datetime | None] = mapped_column()
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class Client(Base):
    __tablename__ = "clients"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    client_id: Mapped[str] = mapped_column(String(100), unique=True)
    user_name: Mapped[str] = mapped_column(String(100))
    user_id: Mapped[str] = mapped_column(String(50))
    department: Mapped[str | None] = mapped_column(String(100))
    hostname: Mapped[str | None] = mapped_column(String(100))
    ip_address: Mapped[str | None] = mapped_column(String(50))
    version: Mapped[str | None] = mapped_column(String(20))
    last_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class SyncState(Base):
    __tablename__ = "sync_state"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source: Mapped[str] = mapped_column(String(50), unique=True)
    last_sync_at: Mapped[datetime | None] = mapped_column()
    last_sync_id: Mapped[str | None] = mapped_column(String(100))
    status: Mapped[str] = mapped_column(String(20), default="idle")
    error_message: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(default=_utcnow)
