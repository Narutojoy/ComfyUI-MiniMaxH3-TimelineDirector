"""Short-lived mobile pairing and timeline-state relay for the Timeline Director.

The relay deliberately keeps sessions in memory in this first implementation.
A ComfyUI restart invalidates active mobile pairings; the workflow's normal
timeline_data remains the durable source of truth.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import secrets
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from aiohttp import WSMsgType, web
from server import PromptServer

log = __import__("logging").getLogger("MiniMaxH3TimelineDirector.MobileSync")

PAIR_TTL_SECONDS = 180
SESSION_TTL_SECONDS = 12 * 60 * 60
MAX_STATE_BYTES = 2 * 1024 * 1024
MAX_REQUEST_BYTES = MAX_STATE_BYTES + 4096
_CODE_RE = re.compile(r"^[A-Z2-9]{8}$")
_sessions: dict[str, "MobileSession"] = {}
_pair_codes: dict[str, tuple[str, float]] = {}
_lock = asyncio.Lock()


@dataclass
class MobileSession:
    node_uuid: str
    state: dict[str, Any]
    token_hash: str
    mobile_token_hash: str = ""
    revision: int = 1
    expires_at: float = field(default_factory=lambda: time.time() + SESSION_TTL_SECONDS)
    sockets: set[web.WebSocketResponse] = field(default_factory=set)


def _json_size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _valid_state(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("timeline state must be a JSON object")
    if _json_size(value) > MAX_STATE_BYTES:
        raise ValueError("timeline state exceeds the 2 MiB limit")
    return value


def _same_origin(request: web.Request) -> bool:
    origin = request.headers.get("Origin")
    if not origin:
        return False
    try:
        from urllib.parse import urlsplit
        parsed = urlsplit(origin)
        return parsed.scheme in {"http", "https"} and parsed.netloc.lower() == request.host.lower()
    except Exception:
        return False


async def _read_json(request: web.Request) -> dict[str, Any]:
    if request.content_length is not None and request.content_length > MAX_REQUEST_BYTES:
        raise web.HTTPRequestEntityTooLarge(max_size=MAX_REQUEST_BYTES, actual_size=request.content_length)
    try:
        value = await request.json()
    except Exception as exc:
        raise ValueError("request body must be valid JSON") from exc
    if not isinstance(value, dict):
        raise ValueError("request body must be a JSON object")
    return value


def _purge_expired() -> None:
    now = time.time()
    for code, (_session_id, expires) in list(_pair_codes.items()):
        if expires <= now:
            _pair_codes.pop(code, None)
    for session_id, session in list(_sessions.items()):
        if session.expires_at <= now:
            _sessions.pop(session_id, None)


def _token_from_request(request: web.Request) -> str:
    value = request.headers.get("Authorization", "")
    scheme, _, token = value.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise web.HTTPUnauthorized(text="Missing session token")
    return token


async def _get_session(request: web.Request) -> MobileSession:
    token = _token_from_request(request)
    digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
    async with _lock:
        _purge_expired()
        session = next((\n            item for item in _sessions.values()\n            if secrets.compare_digest(item.token_hash, digest)\n            or (item.mobile_token_hash and secrets.compare_digest(item.mobile_token_hash, digest))\n        ), None)
    if session is None:
        raise web.HTTPUnauthorized(text="Pairing expired or invalid")
    session.expires_at = time.time() + SESSION_TTL_SECONDS
    return session


async def _broadcast(session: MobileSession, message: dict[str, Any]) -> None:
    stale = []
    payload = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
    for socket in tuple(session.sockets):
        if socket.closed:
            stale.append(socket)
            continue
        try:
            await socket.send_str(payload)
        except Exception:
            stale.append(socket)
    for socket in stale:
        session.sockets.discard(socket)


@PromptServer.instance.routes.post("/minimax_h3_timeline/mobile/pair/create")
async def mobile_pair_create(request: web.Request) -> web.Response:
    if not _same_origin(request):
        raise web.HTTPForbidden(text="Pairing must be started from this ComfyUI page")
    try:
        payload = await _read_json(request)
        node_uuid = str(payload.get("node_uuid") or "")
        uuid.UUID(node_uuid)
        state = _valid_state(payload.get("state"))
    except (ValueError, TypeError) as exc:
        return web.json_response({"error": str(exc)}, status=400)

    session_id = secrets.token_urlsafe(18)
    token = secrets.token_urlsafe(32)
    code = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(8))
    session = MobileSession(
        node_uuid=node_uuid,
        state=state,
        token_hash=hashlib.sha256(token.encode("utf-8")).hexdigest(),
    )
    async with _lock:
        _purge_expired()
        _sessions[session_id] = session
        _pair_codes[code] = (session_id, time.time() + PAIR_TTL_SECONDS)
    return web.json_response({
        "code": code,
        "token": token,
        "node_uuid": node_uuid,
        "revision": session.revision,
        "expires_in": PAIR_TTL_SECONDS,
    })


@PromptServer.instance.routes.post("/minimax_h3_timeline/mobile/pair/claim")
async def mobile_pair_claim(request: web.Request) -> web.Response:
    if not _same_origin(request):
        raise web.HTTPForbidden(text="Pairing must use the same ComfyUI origin")
    try:
        payload = await _read_json(request)
        code = str(payload.get("code") or "").strip().upper()
        if not _CODE_RE.fullmatch(code):
            raise ValueError("Invalid or expired pairing code")
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)

    async with _lock:
        _purge_expired()
        entry = _pair_codes.pop(code, None)
        session = _sessions.get(entry[0]) if entry else None
    if session is None:
        return web.json_response({"error": "Invalid or expired pairing code"}, status=404)

    # The session token is issued once to the desktop. The phone receives a
    # separately generated token so either endpoint can be revoked independently.
    mobile_token = secrets.token_urlsafe(32)
    session.mobile_token_hash = hashlib.sha256(mobile_token.encode("utf-8")).hexdigest()
    return web.json_response({
        "token": mobile_token,
        "node_uuid": session.node_uuid,
        "state": session.state,
        "revision": session.revision,
    })


@PromptServer.instance.routes.get("/minimax_h3_timeline/mobile/state")
async def mobile_state_get(request: web.Request) -> web.Response:
    try:
        session = await _get_session(request)
    except web.HTTPException:
        raise
    return web.json_response({
        "node_uuid": session.node_uuid,
        "state": session.state,
        "revision": session.revision,
    })


@PromptServer.instance.routes.put("/minimax_h3_timeline/mobile/state")
async def mobile_state_put(request: web.Request) -> web.Response:
    try:
        session = await _get_session(request)
        payload = await _read_json(request)
        expected = payload.get("expected_revision")
        if not isinstance(expected, int) or isinstance(expected, bool):
            raise ValueError("expected_revision must be an integer")
        state = _valid_state(payload.get("state"))
    except web.HTTPException:
        raise
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)

    async with _lock:
        if expected != session.revision:
            return web.json_response({
                "error": "revision_conflict",
                "revision": session.revision,
                "state": session.state,
            }, status=409)
        session.state = state
        session.revision += 1
        revision = session.revision
    await _broadcast(session, {"type": "state", "state": state, "revision": revision})
    return web.json_response({"ok": True, "revision": revision})


@PromptServer.instance.routes.get("/minimax_h3_timeline/mobile/events")
async def mobile_events(request: web.Request) -> web.StreamResponse:
    # Browsers cannot attach Authorization headers to WebSocket handshakes.
    # Authenticate with the first WebSocket message instead of leaking tokens
    # into URLs, browser history, or access logs.
    socket = web.WebSocketResponse(heartbeat=25, max_msg_size=1024)
    await socket.prepare(request)
    try:
        first = await asyncio.wait_for(socket.receive(), timeout=8)
        if first.type != WSMsgType.TEXT:
            await socket.close(code=4001, message=b"Authentication required")
            return socket
        try:
            auth = json.loads(first.data)
            token = str(auth.get("token") or "")
        except Exception:
            token = ""
        digest = hashlib.sha256(token.encode("utf-8")).hexdigest() if token else ""
        async with _lock:
            _purge_expired()
            session = next((
                item for item in _sessions.values()
                if secrets.compare_digest(item.token_hash, digest)
                or secrets.compare_digest(getattr(item, "mobile_token_hash", ""), digest)
            ), None)
        if session is None:
            await socket.close(code=4003, message=b"Invalid session")
            return socket
        session.sockets.add(socket)
        await socket.send_json({"type": "ready", "revision": session.revision, "state": session.state})
        async for message in socket:
            if message.type == WSMsgType.ERROR:
                break
            if message.type == WSMsgType.TEXT:
                # State writes use the revision-checked HTTP endpoint; WS is
                # intentionally event-only in this first protocol version.
                await socket.send_json({"type": "notice", "message": "Use the state endpoint to save edits"})
    except asyncio.TimeoutError:
        await socket.close(code=4001, message=b"Authentication timeout")
    finally:
        if "session" in locals() and session:
            session.sockets.discard(socket)
    return socket
