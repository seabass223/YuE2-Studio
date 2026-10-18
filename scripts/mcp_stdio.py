"""stdio entry point for MCP clients that launch servers as a command (e.g. Claude Desktop).

Starts the YuE2 Studio backend if it isn't running, keeps a /api/ws connection open so the
backend stays up while this process lives, and relays MCP messages between stdin/stdout and the
backend's Streamable HTTP endpoint (/mcp). stdout carries only MCP; diagnostics go to stderr.

    .venv\\Scripts\\python.exe scripts\\mcp_stdio.py
"""
import logging
import sys

import anyio
from mcp.client.streamable_http import streamable_http_client
from mcp.server.stdio import stdio_server
from mcp.shared.inbound import (MCP_METHOD_HEADER, MCP_NAME_HEADER, MCP_PROTOCOL_VERSION_HEADER,
                                NAME_BEARING_METHODS, encode_header_value)
from mcp.shared.message import ClientMessageMetadata, SessionMessage
from mcp_types import PROTOCOL_VERSION_META_KEY
from mcp_types.jsonrpc import JSONRPCRequest, JSONRPCResponse
from websockets.asyncio.client import connect

from backend import URL, BackendError, ensure_backend

log = logging.getLogger("yue2-mcp-stdio")


class Relay:
    """Adds the HTTP routing headers a stdio client never had to send."""

    def __init__(self):
        self.version: str | None = None  # negotiated by a pre-2026 initialize handshake
        self.initialize_id = None

    def upstream(self, message: SessionMessage) -> SessionMessage:
        request = message.message
        if not isinstance(request, JSONRPCRequest):
            return message  # notifications reuse the transport's last protocol-version header
        params = request.params or {}
        modern = (params.get("_meta") or {}).get(PROTOCOL_VERSION_META_KEY)
        headers = {}
        if request.method == "initialize":
            self.initialize_id = request.id
        elif modern or self.version:
            headers[MCP_PROTOCOL_VERSION_HEADER] = modern or self.version
        if modern:  # 2026-07-28 per-request envelope: Mcp-Method / Mcp-Name mirror the body
            headers[MCP_METHOD_HEADER] = request.method
            key = NAME_BEARING_METHODS.get(request.method)
            if key and isinstance(params.get(key), str):
                headers[MCP_NAME_HEADER] = encode_header_value(params[key])
        return SessionMessage(request, ClientMessageMetadata(headers=headers or None))

    def downstream(self, message: SessionMessage) -> SessionMessage:
        response = message.message
        if isinstance(response, JSONRPCResponse) and response.id == self.initialize_id:
            self.version = response.result.get("protocolVersion")
        return message


async def keep_backend_alive():
    """The backend shuts down when no page is connected; this socket counts as one."""
    while True:
        try:
            async with connect(URL.replace("http", "ws", 1) + "/api/ws") as socket:
                async for _ in socket:
                    pass
        except Exception as exc:  # backend restarting; retry
            log.debug("presence socket: %s", exc)
        await anyio.sleep(2)


async def main():
    relay = Relay()
    async with (stdio_server() as (client_in, client_out),
                streamable_http_client(f"{URL}/mcp") as (server_in, server_out),
                anyio.create_task_group() as tasks):

        async def up():
            async for item in client_in:
                if isinstance(item, Exception):
                    log.warning("Unparseable message from client: %s", item)
                    continue
                await server_out.send(relay.upstream(item))
            tasks.cancel_scope.cancel()  # client closed stdin

        async def down():
            async for item in server_in:
                if isinstance(item, Exception):
                    log.warning("Backend transport error: %s", item)
                    continue
                await client_out.send(relay.downstream(item))
            tasks.cancel_scope.cancel()

        tasks.start_soon(keep_backend_alive)
        tasks.start_soon(up)
        tasks.start_soon(down)


if __name__ == "__main__":
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING, format="yue2-mcp: %(message)s")
    try:
        ensure_backend()
    except BackendError as exc:
        print(f"yue2-mcp: {exc}", file=sys.stderr)
        sys.exit(1)
    anyio.run(main)
