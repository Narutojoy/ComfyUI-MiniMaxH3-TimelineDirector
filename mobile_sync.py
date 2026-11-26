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
MAX_STATE_BYTES = 8 * 1024 * 1024
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
    reference_size: dict[str, int] = field(default_factory=lambda: {"width": 832, "height": 480})
    mobile_token_hash: str = ""
    revision: int = 1
    updated_at: float = field(default_factory=time.time)
    expires_at: float = field(default_factory=lambda: time.time() + SESSION_TTL_SECONDS)
    sockets: set[web.WebSocketResponse] = field(default_factory=set)
    socket_roles: dict[web.WebSocketResponse, str] = field(default_factory=dict)
    execution_status: dict[str, Any] = field(default_factory=dict)
    queue_status: dict[str, Any] = field(default_factory=lambda: {"queue_running": [], "queue_pending": []})


def _json_size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"))


def _valid_state(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("timeline state must be a JSON object")
    if _json_size(value) > MAX_STATE_BYTES:
        raise ValueError("timeline state exceeds the 8 MiB limit")
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
    raw = await request.read()
    if len(raw) > MAX_REQUEST_BYTES:
        raise web.HTTPRequestEntityTooLarge(max_size=MAX_REQUEST_BYTES, actual_size=len(raw))
    try:
        value = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise ValueError("request body must be valid JSON") from exc
    if not isinstance(value, dict):
        raise ValueError("request body must be a JSON object")
    return value


_socket_close_tasks: set[asyncio.Task[Any]] = set()


async def _close_expired_socket(socket: web.WebSocketResponse) -> None:
    try:
        if not socket.closed:
            await socket.close(code=4002, message=b"Pairing expired")
    except Exception:
        pass


def _purge_expired() -> None:
    now = time.time()
    for code, (_session_id, expires) in list(_pair_codes.items()):
        if expires <= now:
            _pair_codes.pop(code, None)
    for session_id, session in list(_sessions.items()):
        if session.expires_at <= now:
            _sessions.pop(session_id, None)
            for socket in tuple(session.sockets):
                task = asyncio.create_task(_close_expired_socket(socket))
                _socket_close_tasks.add(task)
                task.add_done_callback(_socket_close_tasks.discard)
            session.sockets.clear()


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
        session = next((
            item for item in _sessions.values()
            if secrets.compare_digest(item.token_hash, digest)
            or (item.mobile_token_hash and secrets.compare_digest(item.mobile_token_hash, digest))
        ), None)
        if session is not None:
            session.expires_at = time.time() + SESSION_TTL_SECONDS
    if session is None:
        raise web.HTTPUnauthorized(text="Pairing expired or invalid")
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
        session.socket_roles.pop(socket, None)


async def _send_to_role(session: MobileSession, role: str, message: dict[str, Any]) -> int:
    payload = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
    delivered = 0
    stale = []
    for peer, peer_role in tuple(session.socket_roles.items()):
        if peer_role != role:
            continue
        if peer.closed:
            stale.append(peer)
            continue
        try:
            await peer.send_str(payload)
            delivered += 1
            if role == "desktop":
                break
        except Exception:
            stale.append(peer)
    for peer in stale:
        session.sockets.discard(peer)
        session.socket_roles.pop(peer, None)
    return delivered


@PromptServer.instance.routes.post("/minimax_h3_timeline/mobile/pair/create")
async def mobile_pair_create(request: web.Request) -> web.Response:
    if not _same_origin(request):
        raise web.HTTPForbidden(text="Pairing must be started from this ComfyUI page")
    try:
        payload = await _read_json(request)
        node_uuid = str(payload.get("node_uuid") or "")
        uuid.UUID(node_uuid)
        state = _valid_state(payload.get("state"))
        raw_size = payload.get("reference_size") or {}
        if not isinstance(raw_size, dict):
            raise ValueError("reference_size must be an object")
        reference_size = {
            "width": max(64, min(4096, int(float(raw_size.get("width", 832))))),
            "height": max(64, min(4096, int(float(raw_size.get("height", 480))))),
        }
    except (ValueError, TypeError, OverflowError) as exc:
        return web.json_response({"error": str(exc)}, status=400)

    session_id = secrets.token_urlsafe(18)
    token = secrets.token_urlsafe(32)
    code = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(8))
    session = MobileSession(
        node_uuid=node_uuid,
        state=state,
        token_hash=hashlib.sha256(token.encode("utf-8")).hexdigest(),
        reference_size=reference_size,
    )
    old_sockets: list[web.WebSocketResponse] = []
    async with _lock:
        _purge_expired()
        # A node has one active mobile pairing at a time. Re-pairing revokes
        # its previous tokens and makes any older unclaimed code unusable.
        for old_id, old_session in list(_sessions.items()):
            if old_session.node_uuid != node_uuid:
                continue
            _sessions.pop(old_id, None)
            old_sockets.extend(old_session.sockets)
            for old_code, (bound_id, _expires) in list(_pair_codes.items()):
                if bound_id == old_id:
                    _pair_codes.pop(old_code, None)
        _sessions[session_id] = session
        _pair_codes[code] = (session_id, time.time() + PAIR_TTL_SECONDS)
    for old_socket in old_sockets:
        if not old_socket.closed:
            await old_socket.close(code=4002, message=b"Pairing replaced")
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
        if session is not None:
            # Bind the mobile credential while still holding the session lock,
            # so a simultaneous re-pair cannot issue a token for a revoked session.
            mobile_token = secrets.token_urlsafe(32)
            session.mobile_token_hash = hashlib.sha256(mobile_token.encode("utf-8")).hexdigest()
    if session is None:
        return web.json_response({"error": "Invalid or expired pairing code"}, status=404)
    await _broadcast(session, {"type": "paired", "node_uuid": session.node_uuid})
    return web.json_response({
        "token": mobile_token,
        "node_uuid": session.node_uuid,
        "state": session.state,
        "revision": session.revision,
        "updated_at": session.updated_at,
        "reference_size": session.reference_size,
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
        "updated_at": session.updated_at,
        "reference_size": session.reference_size,
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
        if not any(item is session for item in _sessions.values()):
            raise web.HTTPUnauthorized(text="Pairing was replaced or revoked")
        if expected != session.revision:
            return web.json_response({
                "error": "revision_conflict",
                "revision": session.revision,
                "state": session.state,
            }, status=409)
        session.state = state
        session.revision += 1
        session.updated_at = time.time()
        revision = session.revision
        updated_at = session.updated_at
    await _broadcast(session, {"type": "state", "state": state, "revision": revision, "updated_at": updated_at})
    return web.json_response({"ok": True, "revision": revision, "updated_at": updated_at})


@PromptServer.instance.routes.post("/minimax_h3_timeline/mobile/session/revoke")
async def mobile_session_revoke(request: web.Request) -> web.Response:
    """Revoke the calling mobile credential and its paired session."""
    if not _same_origin(request):
        raise web.HTTPForbidden(text="Revocation must use the same ComfyUI origin")
    token = _token_from_request(request)
    digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
    sockets: list[web.WebSocketResponse] = []
    async with _lock:
        _purge_expired()
        match = next(((sid, item) for sid, item in _sessions.items()
                      if secrets.compare_digest(item.token_hash, digest)
                      or (item.mobile_token_hash and secrets.compare_digest(item.mobile_token_hash, digest))), None)
        if match is None:
            raise web.HTTPUnauthorized(text="Pairing is already revoked or expired")
        session_id, session = match
        _sessions.pop(session_id, None)
        sockets.extend(session.sockets)
        session.sockets.clear()
        for code, (bound_id, _expires) in list(_pair_codes.items()):
            if bound_id == session_id:
                _pair_codes.pop(code, None)
    for socket in sockets:
        if not socket.closed:
            try:
                await socket.close(code=4002, message=b"Mobile pairing revoked")
            except Exception:
                pass
    return web.json_response({"ok": True, "revoked": True})


@PromptServer.instance.routes.get("/minimax_h3_timeline/mobile/events")
async def mobile_events(request: web.Request) -> web.StreamResponse:
    if not _same_origin(request):
        raise web.HTTPForbidden(text="WebSocket must use the same ComfyUI origin")
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
            match = next((
                (item, "desktop" if secrets.compare_digest(item.token_hash, digest) else "mobile")
                for item in _sessions.values()
                if token and (
                    secrets.compare_digest(item.token_hash, digest)
                    or (item.mobile_token_hash and secrets.compare_digest(item.mobile_token_hash, digest))
                )
            ), None)
            session, socket_role = match if match else (None, "")
        if session is None:
            await socket.close(code=4003, message=b"Invalid session")
            return socket
        async with _lock:
            if not any(item is session for item in _sessions.values()):
                session = None
            else:
                session.sockets.add(socket)
                session.socket_roles[socket] = socket_role
        if session is None:
            await socket.close(code=4003, message=b"Session revoked")
            return socket
        await socket.send_json({"type": "ready", "revision": session.revision, "updated_at": session.updated_at, "state": session.state, "execution_status": session.execution_status, "queue_status": session.queue_status})
        async for message in socket:
            if message.type == WSMsgType.ERROR:
                break
            if message.type != WSMsgType.TEXT:
                continue
            try:
                event = json.loads(message.data)
            except Exception:
                continue
            if not isinstance(event, dict):
                continue
            event_type = str(event.get("type") or "")
            if socket_role == "mobile":
                if event_type not in {"run_request", "interrupt_request", "save_request"}:
                    await socket.send_json({"type": "command_result", "request_id": event.get("request_id"), "ok": False, "error": "unsupported_command"})
                    continue
                request_id = str(event.get("request_id") or "")
                try:
                    uuid.UUID(request_id)
                except (ValueError, TypeError, AttributeError):
                    await socket.send_json({"type": "command_result", "request_id": request_id, "ok": False, "error": "invalid_request_id"})
                    continue
                if event_type in {"run_request", "save_request"}:
                    command_revision = event.get("revision")
                    if not isinstance(command_revision, int) or isinstance(command_revision, bool):
                        await socket.send_json({"type": "command_result", "request_id": request_id, "ok": False, "error": "invalid_revision"})
                        continue
                    if command_revision != session.revision:
                        await socket.send_json({"type": "command_result", "request_id": request_id, "ok": False, "error": "revision_mismatch", "revision": session.revision})
                        continue
                else:
                    # Stopping an active job must remain available even if the
                    # timeline state has changed since the job was submitted.
                    command_revision = session.revision
                command = {"type": event_type, "request_id": request_id, "revision": command_revision}
                if event_type == "interrupt_request":
                    command["prompt_id"] = str(event.get("prompt_id") or "")[:128]
                delivered = await _send_to_role(session, "desktop", command)
                if not delivered:
                    await socket.send_json({"type": "command_result", "request_id": request_id, "ok": False, "error": "desktop_offline"})
            elif socket_role == "desktop":
                if event_type in {"command_result", "execution_status", "queue_status"}:
                    safe_event = {"type": event_type}
                    for key in ("request_id", "ok", "error", "status", "prompt_id", "node", "value", "max", "message", "percent", "segment_index", "segment_count"):
                        if key in event:
                            value = event[key]
                            if isinstance(value, (str, int, float, bool)) or value is None:
                                safe_event[key] = value if not isinstance(value, str) else value[:512]
                    if event_type == "queue_status":
                        def clean_items(items: Any) -> list[dict[str, Any]]:
                            if not isinstance(items, list):
                                return []
                            cleaned = []
                            for item in items[:100]:
                                if not isinstance(item, dict):
                                    continue
                                prompt_id = str(item.get("prompt_id") or "")[:128]
                                label = str(item.get("label") or "工作流任务")[:120]
                                number = item.get("number", 0)
                                created = item.get("create_time", 0)
                                cleaned.append({
                                    "prompt_id": prompt_id,
                                    "label": label,
                                    "number": number if isinstance(number, (int, float)) and not isinstance(number, bool) else 0,
                                    "create_time": created if isinstance(created, (int, float)) and not isinstance(created, bool) else 0,
                                })
                            return cleaned
                        safe_event["queue_running"] = clean_items(event.get("queue_running"))
                        safe_event["queue_pending"] = clean_items(event.get("queue_pending"))
                        session.queue_status = {"queue_running": safe_event["queue_running"], "queue_pending": safe_event["queue_pending"]}
                    elif event_type == "execution_status":
                        session.execution_status = safe_event
                    elif event_type == "command_result" and event.get("status") in {"queued", "interrupt_requested"}:
                        current_status = session.execution_status.get("status")
                        terminal = current_status in {"completed", "failed", "interrupted"}
                        if not terminal and not (event.get("status") == "queued" and current_status == "running"):
                            session.execution_status = {
                                "type": "execution_status",
                                "status": "queued" if event.get("status") == "queued" else "stopping",
                                "prompt_id": str(event.get("prompt_id") or "")[:128],
                            }
                    await _send_to_role(session, "mobile", safe_event)
    except asyncio.TimeoutError:
        await socket.close(code=4001, message=b"Authentication timeout")
    finally:
        if "session" in locals() and session:
            session.sockets.discard(socket)
            session.socket_roles.pop(socket, None)
    return socket
