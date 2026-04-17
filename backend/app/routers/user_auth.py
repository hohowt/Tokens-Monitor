"""用户注册/登录端点。"""

import secrets
from datetime import datetime, timezone

import bcrypt
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Department, User

router = APIRouter(prefix="/api/auth", tags=["auth"])


# ── Schemas ──────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    email: str = Field(..., min_length=3, max_length=200)
    department: str | None = None
    password: str = Field(..., min_length=6, max_length=128)


class LoginRequest(BaseModel):
    email: str = Field(..., min_length=1)
    password: str = Field(..., min_length=1)


class SetPasswordRequest(BaseModel):
    email: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1)
    password: str = Field(..., min_length=6, max_length=128)


class BindEmailRequest(BaseModel):
    employee_id: str = Field(..., min_length=1, description="原工号")
    name: str = Field(..., min_length=1, description="姓名（用于验证身份）")
    email: str = Field(..., min_length=3, max_length=200)
    password: str = Field(..., min_length=6, max_length=128)


class ChangePasswordRequest(BaseModel):
    email: str = Field(..., min_length=1)
    old_password: str = Field(..., min_length=1)
    new_password: str = Field(..., min_length=6, max_length=128)


class AuthResponse(BaseModel):
    employee_id: str
    name: str
    department: str | None = None
    auth_token: str


# ── Helpers ──────────────────────────────────────────────────

def _hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def _check_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())


def _generate_token() -> str:
    return secrets.token_hex(32)


def _normalize(value: str | None) -> str:
    return (value or "").strip()


def _same_name(left: str | None, right: str | None) -> bool:
    a = _normalize(left).lower().replace(" ", "")
    b = _normalize(right).lower().replace(" ", "")
    return bool(a and b and a == b)


async def _get_or_create_department(db: AsyncSession, name: str | None) -> int | None:
    normalized = _normalize(name)
    if not normalized:
        return None
    result = await db.execute(select(Department).where(Department.name == normalized))
    dept = result.scalar_one_or_none()
    if dept:
        return dept.id
    dept = Department(name=normalized)
    db.add(dept)
    await db.flush()
    return dept.id


async def _get_department_name(db: AsyncSession, dept_id: int | None) -> str | None:
    if dept_id is None:
        return None
    dept = await db.get(Department, dept_id)
    return dept.name if dept else None


async def _next_employee_id(db: AsyncSession) -> str:
    result = await db.execute(text("SELECT nextval('employee_id_seq')"))
    return str(result.scalar_one())


async def _find_user_by_email(db: AsyncSession, email: str) -> User | None:
    """按 email 查找活跃用户；若未找到则回退到 employee_id（兼容老用户）。"""
    normalized = _normalize(email)
    result = await db.execute(
        select(User).where(User.email == normalized, User.is_active == True)  # noqa: E712
    )
    user = result.scalar_one_or_none()
    if user:
        return user
    result = await db.execute(
        select(User).where(User.employee_id == normalized, User.is_active == True)  # noqa: E712
    )
    return result.scalar_one_or_none()


def _build_response(user: User, dept_name: str | None) -> AuthResponse:
    return AuthResponse(
        employee_id=user.email or user.employee_id,
        name=user.name,
        department=dept_name,
        auth_token=user.auth_token,  # type: ignore[arg-type]
    )


# ── Endpoints ────────────────────────────────────────────────

@router.post("/register", response_model=AuthResponse)
async def register(body: RegisterRequest, db: AsyncSession = Depends(get_db)):
    name = _normalize(body.name)
    if not name:
        raise HTTPException(400, "姓名不能为空")
    email = _normalize(body.email)
    if not email:
        raise HTTPException(400, "邮箱不能为空")

    existing = await db.execute(
        select(User).where(User.email == email)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(409, "该邮箱已注册")

    # 自动绑定：如果有同名老用户且尚未绑定邮箱，直接绑定到老账号（保留历史数据）
    candidates = await db.execute(
        select(User).where(User.is_active == True, User.email.is_(None))  # noqa: E712
    )
    matched_user = None
    for u in candidates.scalars().all():
        if _same_name(u.name, name):
            matched_user = u
            break

    if matched_user:
        matched_user.email = email
        matched_user.password_hash = _hash_password(body.password)
        matched_user.auth_token = _generate_token()
        matched_user.auth_token_created_at = datetime.now(timezone.utc)
        if body.department:
            dept_id = await _get_or_create_department(db, body.department)
            if dept_id:
                matched_user.department_id = dept_id
        await db.commit()
        dept_name = await _get_department_name(db, matched_user.department_id)
        return _build_response(matched_user, dept_name)

    dept_id = await _get_or_create_department(db, body.department)
    employee_id = await _next_employee_id(db)

    user = User(
        employee_id=employee_id,
        name=name,
        email=email,
        department_id=dept_id,
        password_hash=_hash_password(body.password),
        auth_token=_generate_token(),
        auth_token_created_at=datetime.now(timezone.utc),
    )
    db.add(user)
    await db.commit()

    dept_name = await _get_department_name(db, dept_id)
    return _build_response(user, dept_name)


@router.post("/login", response_model=AuthResponse)
async def login(body: LoginRequest, db: AsyncSession = Depends(get_db)):
    user = await _find_user_by_email(db, body.email)

    if not user:
        raise HTTPException(401, "invalid_credentials")

    if not user.password_hash:
        raise HTTPException(403, "password_not_set")

    if not _check_password(body.password, user.password_hash):
        raise HTTPException(401, "invalid_credentials")

    user.auth_token = _generate_token()
    user.auth_token_created_at = datetime.now(timezone.utc)
    await db.commit()

    dept_name = await _get_department_name(db, user.department_id)
    return _build_response(user, dept_name)


@router.post("/set-password", response_model=AuthResponse)
async def set_password(body: SetPasswordRequest, db: AsyncSession = Depends(get_db)):
    user = await _find_user_by_email(db, body.email)

    if not user:
        raise HTTPException(404, "user_not_found")

    if user.password_hash:
        raise HTTPException(409, "password_already_set")

    if not _same_name(user.name, body.name):
        raise HTTPException(403, "name_mismatch")

    user.password_hash = _hash_password(body.password)
    user.auth_token = _generate_token()
    user.auth_token_created_at = datetime.now(timezone.utc)
    await db.commit()

    dept_name = await _get_department_name(db, user.department_id)
    return _build_response(user, dept_name)


@router.post("/bind-email", response_model=AuthResponse)
async def bind_email(body: BindEmailRequest, db: AsyncSession = Depends(get_db)):
    """用老工号 + 姓名验证身份，将邮箱绑定到已有账号（保留历史数据）。"""
    employee_id = _normalize(body.employee_id)
    name = _normalize(body.name)
    email = _normalize(body.email)

    if not employee_id or not name or not email:
        raise HTTPException(400, "工号、姓名和邮箱均为必填")

    existing_email = await db.execute(select(User).where(User.email == email))
    if existing_email.scalar_one_or_none():
        raise HTTPException(409, "该邮箱已被其他账号使用")

    result = await db.execute(
        select(User).where(User.employee_id == employee_id, User.is_active == True)  # noqa: E712
    )
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(404, "未找到该工号对应的账号")

    if not _same_name(user.name, name):
        raise HTTPException(403, "姓名与该工号记录不匹配")

    user.email = email
    user.password_hash = _hash_password(body.password)
    user.auth_token = _generate_token()
    user.auth_token_created_at = datetime.now(timezone.utc)
    await db.commit()

    dept_name = await _get_department_name(db, user.department_id)
    return _build_response(user, dept_name)


@router.post("/change-password", response_model=AuthResponse)
async def change_password(body: ChangePasswordRequest, db: AsyncSession = Depends(get_db)):
    """修改密码：验证旧密码后设置新密码，同时刷新 auth_token。"""
    user = await _find_user_by_email(db, body.email)

    if not user:
        raise HTTPException(401, "invalid_credentials")

    if not user.password_hash:
        raise HTTPException(403, "password_not_set")

    if not _check_password(body.old_password, user.password_hash):
        raise HTTPException(401, "invalid_credentials")

    if body.old_password == body.new_password:
        raise HTTPException(400, "新密码不能与旧密码相同")

    user.password_hash = _hash_password(body.new_password)
    user.auth_token = _generate_token()
    user.auth_token_created_at = datetime.now(timezone.utc)
    await db.commit()

    dept_name = await _get_department_name(db, user.department_id)
    return _build_response(user, dept_name)
