import json
from typing import Any

import httpx


LOCAL_BASE = "http://127.0.0.1:8767/mcp"
CLOUD_BASE = "https://api.squishplugin.dev/mcp"
TIMEOUT_SECONDS = 30
PLUGIN_NAME = "squish-memory"


def _resolve_bases() -> tuple[str, str | None]:
    try:
        from os import getenv
        base = (getenv("SQUISH_MCP_URL", "") or "").strip()
    except Exception:
        base = ""
    if not base:
        base = LOCAL_BASE
    fallback = CLOUD_BASE if base == LOCAL_BASE else None
    return base, fallback


def _api_key() -> str:
    try:
        from os import getenv
        return (getenv("SQUISH_API_KEY", "") or "").strip()
    except Exception:
        return ""


class _RpcResult:
    def __init__(self, payload: dict[str, Any], session_id: str | None) -> None:
        self.payload = payload
        self.session_id = session_id


class SquishMcpClient:
    def __init__(self, base_url: str, api_key: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.session_id: str | None = None
        self._next_id = 1

    def _headers(self) -> dict[str, str]:
        headers: dict[str, str] = {
            "content-type": "application/json",
            "accept": "application/json, text/event-stream",
        }
        if self.api_key:
            headers["x-api-key"] = self.api_key
            headers["authorization"] = f"Bearer {self.api_key}"
        if self.session_id:
            headers["mcp-session-id"] = self.session_id
        return headers

    def _rpc(self, payload: dict[str, Any]) -> _RpcResult:
        payload = {**payload, "jsonrpc": "2.0", "id": self._next_id}
        self._next_id += 1
        with httpx.Client(timeout=TIMEOUT_SECONDS) as client:
            response = client.post(self.base_url, json=payload, headers=self._headers())
        response.raise_for_status()
        body = response.text
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            raise RuntimeError(f"Non-JSON MCP response: {body[:220]}")
        if isinstance(parsed, list):
            raise RuntimeError("Unexpected array MCP response")
        if "error" in parsed:
            raise RuntimeError(f"MCP error: {json.dumps(parsed['error'], ensure_ascii=False)[:220]}")
        session_id = response.headers.get("mcp-session-id") or self.session_id
        return _RpcResult(payload=parsed, session_id=session_id)

    def initialize(self) -> None:
        result = self._rpc(
            {
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "hermes-plugin", "version": "0.1.0"},
                },
            }
        )
        self.session_id = result.session_id
        if not self.session_id:
            raise RuntimeError("Squish MCP server did not return an mcp-session-id")
        try:
            self._rpc({"method": "notifications/initialized"})
        except Exception:
            pass

    def call_tool(self, name: str, arguments: dict[str, Any]) -> str:
        if not self.session_id:
            self.initialize()
        result = self._rpc(
            {
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments or {}},
            }
        )
        self.session_id = result.session_id or self.session_id
        content = (((result.payload.get("result") or {}).get("content")) or [])
        texts = [part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") == "text"]
        return texts[0] if texts else json.dumps({"ok": True, "raw": result.payload})


def _client_for(base_url: str) -> SquishMcpClient:
    client = SquishMcpClient(base_url=base_url, api_key=_api_key())
    client.initialize()
    return client


def _call(tool: str, arguments: dict[str, Any]) -> str:
    bases = [_resolve_bases()[0]]
    fallback = _resolve_bases()[1]
    if fallback:
        bases.append(fallback)
    last_error: Exception | None = None
    for base in bases:
        try:
            client = _client_for(base)
            return client.call_tool(tool, arguments)
        except Exception as exc:
            last_error = exc
    raise RuntimeError(f"squish-memory MCP call failed: {last_error}")


def _wrap(raw: str, meta: dict[str, object]) -> str:
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            merged = {**meta, **parsed}
            return json.dumps(merged, ensure_ascii=False)
    except json.JSONDecodeError:
        pass
    return json.dumps({**meta, "text": raw}, ensure_ascii=False)


def remember(params: dict[str, Any], **_: Any) -> str:
    arguments: dict[str, object] = {
        "content": params["content"],
        "type": params.get("type") or "observation",
        "tags": params.get("tags") or [],
        "source": params.get("source") or "plugin",
    }
    project = (params.get("project") or "").strip()
    if project:
        arguments["project"] = project
    return _wrap(_call("squish_remember", arguments), {"ok": True, "tool": "squish_remember"})


def recall(params: dict[str, Any], **_: Any) -> str:
    arguments: dict[str, object] = {
        "query": params["query"],
        "limit": int(params.get("limit") or 10),
    }
    project = (params.get("project") or "").strip()
    if project:
        arguments["project"] = project
    return _wrap(_call("squish_recall", arguments), {"ok": True, "tool": "squish_recall"})


def context(params: dict[str, Any], **_: Any) -> str:
    arguments: dict[str, object] = {"limit": int(params.get("limit") or 10)}
    project = (params.get("project") or "").strip()
    if project:
        arguments["project"] = project
    return _wrap(_call("squish_context", arguments), {"ok": True, "tool": "squish_context"})


def search(params: dict[str, Any], **_: Any) -> str:
    arguments = {"query": params.get("query", ""), "limit": int(params.get("limit") or 10)}
    return _wrap(_call("squish_search", arguments), {"ok": True, "tool": "squish_search"})


def stats(params: dict[str, Any], **_: Any) -> str:
    return _wrap(_call("squish_stats", params or {}), {"ok": True, "tool": "squish_stats"})


def health(params: dict[str, Any], **_: Any) -> str:
    return _wrap(_call("squish_health", params or {}), {"ok": True, "tool": "squish_health"})


def connectors_list(params: dict[str, Any], **_: Any) -> str:
    arguments: dict[str, object] = {}
    connector_type = (params.get("type") or "").strip()
    if connector_type:
        arguments["type"] = connector_type
    return _wrap(_call("squish_connectors", arguments), {"ok": True, "tool": "squish_connectors"})


def ingest(params: dict[str, Any], **_: Any) -> str:
    arguments: dict[str, object] = {"all": bool(params.get("all"))}
    connector_id = (params.get("connector_id") or "").strip()
    if connector_id:
        arguments["connector_id"] = connector_id
    return _wrap(_call("squish_ingest", arguments), {"ok": True, "tool": "squish_ingest"})


def ingestion_status(params: dict[str, Any], **_: Any) -> str:
    arguments: dict[str, object] = {}
    connector_id = (params.get("connector_id") or "").strip()
    if connector_id:
        arguments["connector_id"] = connector_id
    return _wrap(_call("squish_ingestion_status", arguments), {"ok": True, "tool": "squish_ingestion_status"})


def connector_types(params: dict[str, Any], **_: Any) -> str:
    return _wrap(_call("squish_connector_types", params or {}), {"ok": True, "tool": "squish_connector_types"})


_SQUISH_REMEMBER = {
    "name": "squish_remember",
    "description": "Store a memory in Squish. Local-first; uses the running squish-memory runtime.",
    "parameters": {
        "type": "object",
        "properties": {
            "content": {"type": "string", "description": "Full memory text to store."},
            "type": {
                "type": "string",
                "enum": ["observation", "fact", "decision", "context", "preference", "note"],
                "description": "Memory type. Auto-detected if omitted.",
            },
            "tags": {"type": "array", "items": {"type": "string"}, "description": "Tags for organization."},
            "project": {"type": "string", "description": "Optional project path for scoped storage."},
            "source": {
                "type": "string",
                "enum": ["cli", "voice", "chat", "document", "plugin"],
                "description": "Source of the memory.",
            },
        },
        "required": ["content"],
    },
}

_SQUISH_RECALL = {
    "name": "squish_recall",
    "description": "Recall memories by query or memory ID.",
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search query or memory ID."},
            "limit": {"type": "integer", "description": "Max results. Defaults to 10."},
            "project": {"type": "string", "description": "Optional project path."},
        },
        "required": ["query"],
    },
}

_SQUISH_CONTEXT = {
    "name": "squish_context",
    "description": "Get recent or project-scoped context from local Squish memory.",
    "parameters": {
        "type": "object",
        "properties": {
            "limit": {"type": "integer", "description": "Number of context items. Defaults to 10."},
            "project": {"type": "string", "description": "Optional project path."},
        },
    },
}

_SQUISH_SEARCH = {
    "name": "squish_search",
    "description": "Full hybrid search over local Squish memory.",
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search query."},
            "limit": {"type": "integer", "description": "Max results. Defaults to 10."},
        },
        "required": ["query"],
    },
}

_SQUISH_STATS = {
    "name": "squish_stats",
    "description": "Get Squish local runtime stats and health summary.",
    "parameters": {"type": "object", "properties": {}, "required": []},
}

_SQUISH_HEALTH = {
    "name": "squish_health",
    "description": "Check whether the local Squish memory runtime is reachable.",
    "parameters": {"type": "object", "properties": {}, "required": []},
}

_SQUISH_CONNECTORS = {
    "name": "squish_connectors",
    "description": "List configured Squish connectors, optionally filtered by type.",
    "parameters": {
        "type": "object",
        "properties": {
            "type": {"type": "string", "description": "Optional connector type filter, e.g. google_drive, github, slack, notion."}
        },
    },
}

_SQUISH_INGEST = {
    "name": "squish_ingest",
    "description": "Trigger connector ingestion from the local Squish runtime.",
    "parameters": {
        "type": "object",
        "properties": {
            "connector_id": {"type": "string", "description": "Connector ID. Omit to run all connectors."},
            "all": {"type": "boolean", "description": "Run ingestion for all connectors with new documents."},
        },
    },
}

_SQUISH_INGESTION_STATUS = {
    "name": "squish_ingestion_status",
    "description": "Check ingestion status for one or all connectors.",
    "parameters": {
        "type": "object",
        "properties": {
            "connector_id": {"type": "string", "description": "Connector ID. Omit for all connectors."}
        },
    },
}

_SQUISH_CONNECTOR_TYPES = {
    "name": "squish_connector_types",
    "description": "List available connector types and whether they are configured.",
    "parameters": {"type": "object", "properties": {}, "required": []},
}


def _log_tool_call(tool_name: str, params: dict[str, Any], result: Any, **_: Any) -> None:
    try:
        text = result.content[0].text if result and getattr(result, "content", None) else ""
        print(json.dumps({"tool": tool_name, "params": params, "result_preview": str(text)[:220]}, ensure_ascii=False))
    except Exception:
        pass


def register(ctx):
    tools = [
        ("squish_remember", _SQUISH_REMEMBER, remember),
        ("squish_recall", _SQUISH_RECALL, recall),
        ("squish_context", _SQUISH_CONTEXT, context),
        ("squish_search", _SQUISH_SEARCH, search),
        ("squish_stats", _SQUISH_STATS, stats),
        ("squish_health", _SQUISH_HEALTH, health),
        ("squish_connectors", _SQUISH_CONNECTORS, connectors_list),
        ("squish_ingest", _SQUISH_INGEST, ingest),
        ("squish_ingestion_status", _SQUISH_INGESTION_STATUS, ingestion_status),
        ("squish_connector_types", _SQUISH_CONNECTOR_TYPES, connector_types),
    ]
    for name, schema, handler in tools:
        ctx.register_tool(name=name, toolset=PLUGIN_NAME, schema=schema, handler=handler)
    ctx.register_hook("post_tool_call", _log_tool_call)
