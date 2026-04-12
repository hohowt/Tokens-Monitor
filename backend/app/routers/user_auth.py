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
    department: str | None = None
    password: str = Field(..., min_length=4, max_length=128)


class LoginRequest(BaseModel):
    employee_id: str = Field(..., min_length=1)
    password: str = Field(..., min_length=1)


class SetPasswordRequest(BaseModel):
    employee_id: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1)
    password: str = Field(..., min_length=4, max_length=128)


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


def _build_response(user: User, dept_name: str | None) -> AuthResponse:
    return AuthResponse(
        employee_id=user.employee_id,
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

    dept_id = await _get_or_create_department(db, body.department)
    employee_id = await _next_employee_id(db)

    user = User(
        employee_id=employee_id,
        name=name,
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
    employee_id = _normalize(body.employee_id)
    result = await db.execute(
        select(User).where(User.employee_id == employee_id, User.is_active == True)  # noqa: E712
    )
    user = result.scalar_one_or_none()

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
    employee_id = _normalize(body.employee_id)
    result = await db.execute(
        select(User).where(User.employee_id == employee_id, User.is_active == True)  # noqa: E712
    )
    user = result.scalar_one_or_none()

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
