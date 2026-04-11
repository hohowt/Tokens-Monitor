"""
Extension distribution: version check and VSIX download.

VSIX files are stored in the directory specified by EXTENSION_DIR setting
(default: /opt/token-monitor/extensions/).

To publish a new version, simply copy the VSIX file into that directory.
The latest version is determined by scanning filenames that match the pattern
ai-token-monitor-*-<version>.vsix (semver extracted from the filename).
"""

import re
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.config import settings

router = APIRouter(prefix="/api/extension", tags=["extension"])

EXTENSION_DIR = Path(getattr(settings, "EXTENSION_DIR", "/opt/token-monitor/extensions"))

_VSIX_RE = re.compile(
    r"^ai-token-monitor-(?P<target>[a-z0-9-]+)-(?P<version>\d+\.\d+\.\d+)\.vsix$"
)


def _parse_semver(v: str) -> tuple[int, ...]:
    return tuple(int(x) for x in v.split("."))


def _scan_latest() -> dict[str, dict]:
    """Scan extension dir and return {target: {version, filename}} for the latest version per target."""
    if not EXTENSION_DIR.is_dir():
        return {}
    results: dict[str, dict] = {}
    for f in EXTENSION_DIR.iterdir():
        m = _VSIX_RE.match(f.name)
        if not m:
            continue
        target = m.group("target")
        version = m.group("version")
        if target not in results or _parse_semver(version) > _parse_semver(results[target]["version"]):
            results[target] = {"version": version, "filename": f.name, "target": target}
    return results


@router.get("/latest")
async def get_latest(target: str = "win32-x64"):
    """Return the latest available version for a given platform target."""
    latest = _scan_latest()
    info = latest.get(target)
    if not info:
        raise HTTPException(404, f"No extension found for target '{target}'")
    base_url = f"/api/extension/download/{info['filename']}"
    return {
        "version": info["version"],
        "target": info["target"],
        "download_url": base_url,
        "filename": info["filename"],
    }


@router.get("/download/{filename}")
async def download_vsix(filename: str):
    """Download a specific VSIX file."""
    # Sanitize: only allow expected filenames
    if not _VSIX_RE.match(filename):
        raise HTTPException(400, "Invalid filename")
    filepath = EXTENSION_DIR / filename
    if not filepath.is_file():
        raise HTTPException(404, "File not found")
    return FileResponse(
        filepath,
        media_type="application/octet-stream",
        filename=filename,
    )
