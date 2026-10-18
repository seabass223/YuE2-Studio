"""Reference headless invoker for the MCP Micro-UI Jobs profile (spec: ../../README.md, section 7).

Works against any conforming server. It starts a job, follows it with long-polls (printing
progress), fetches every artifact with resources/read, verifies size and sha256, and writes the
files.

    python invoker.py --url http://127.0.0.1:7862/mcp --args '{"style": "lofi piano", "instrumental": true, "max_seconds": 20}' --out ./out
    python invoker.py --stdio "python path/to/server.py" --args @args.json --out ./out

The process exits with 0 when the payload is delivered, 1 when the job fails or is cancelled,
and 2 on a protocol or usage error.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import shlex
import sys
from pathlib import Path
from typing import Any

from mcp import Client
from mcp.client import advertise
from mcp.client.stdio import StdioServerParameters

PROFILE = "dev.micro-ui/jobs"
VERSION = "0.1.0"
TERMINAL = {"completed", "failed", "cancelled"}
LONG_POLL_MS = 25_000


class JobEnded(Exception):
    """The job finished without a payload (failed or cancelled)."""


class ProtocolError(Exception):
    pass


def role(tool) -> dict[str, Any]:
    return (tool.meta or {}).get(PROFILE) or {}


def structured(result, what: str) -> dict[str, Any]:
    content = result.structured_content or {}
    if result.is_error:
        error = content.get("error") or {}
        raise ProtocolError(f"{what}: {error.get('code', 'error')}: {error.get('message', result.content)}")
    return content


async def find_start_tool(client: Client, name: str | None):
    starts = [t for t in (await client.list_tools()).tools if role(t).get("role") == "start"]
    if name:
        starts = [t for t in starts if t.name == name]
    if len(starts) != 1:
        found = ", ".join(t.name for t in starts) or "none"
        raise ProtocolError(f"Need exactly one start tool{f' named {name!r}' if name else ''}; found: {found}")
    return starts[0]


async def follow(client: Client, handle: dict[str, Any], log) -> dict[str, Any]:
    """Long-polls the status tool until the job reaches a terminal state (spec 3.2, 7.4)."""
    last = None

    async def on_progress(progress: float, total: float | None, message: str | None) -> None:
        log(f"  {progress / (total or 1):6.1%}  {message or ''}")

    while True:
        result = await client.call_tool(handle["statusTool"], {"jobId": handle["jobId"], "waitMs": LONG_POLL_MS},
                                        progress_callback=on_progress, read_timeout_seconds=LONG_POLL_MS / 1000 + 15)
        status = structured(result, "status")
        line = (status["state"], status["phase"], status["message"])
        if line != last:
            last = line
            progress = "" if status["progress"] is None else f"{status['progress']:6.1%}  "
            log(f"[{status['state']}/{status['phase']}] {progress}{status['message']}")
        if status["state"] in TERMINAL:
            return status


async def fetch(client: Client, artifact: dict[str, Any]) -> bytes:
    """resources/read the artifact and check it against its descriptor (spec 5)."""
    contents = (await client.read_resource(artifact["uri"])).contents
    if not contents:
        raise ProtocolError(f"{artifact['uri']}: empty resources/read result")
    item = contents[0]
    data = base64.b64decode(item.blob) if getattr(item, "blob", None) is not None else item.text.encode("utf-8")
    if len(data) != artifact["size"]:
        raise ProtocolError(f"{artifact['uri']}: size {len(data)} != declared {artifact['size']}")
    digest = hashlib.sha256(data).hexdigest()
    if digest != artifact["sha256"]:
        raise ProtocolError(f"{artifact['uri']}: sha256 {digest} != declared {artifact['sha256']}")
    return data


async def invoke(client: Client, tool: str | None, args: dict[str, Any], out: Path, log=print) -> dict[str, Any]:
    start = await find_start_tool(client, tool)
    handle = structured(await client.call_tool(start.name, args), "start")
    if handle.get("state") == "input_required":
        raise ProtocolError(f"Server needs input it cannot get without a UI: missing {handle.get('missing')}")
    log(f"started {handle['jobId']} via {start.name}")

    status = await follow(client, handle, log)
    if status["state"] != "completed":
        raise JobEnded(f"{status['state']}: {status['message']}")

    result = structured(await client.call_tool(handle["resultTool"], {"jobId": handle["jobId"]}), "result")
    out.mkdir(parents=True, exist_ok=True)
    for artifact in result["artifacts"]:
        data = await fetch(client, artifact)
        path = out / Path(artifact["name"]).name  # never trust a server-supplied path
        path.write_bytes(data)
        log(f"delivered {artifact['role']:9} {path}  {artifact['mimeType']}  {len(data):,} bytes  sha256 ok")
    return result


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--url", help="Streamable HTTP endpoint, e.g. http://127.0.0.1:7862/mcp")
    target.add_argument("--stdio", help="Command line that launches a stdio MCP server")
    parser.add_argument("--tool", help="Start tool name (default: the server's only start tool)")
    parser.add_argument("--args", default="{}", help="Start tool arguments as JSON, or @file.json")
    parser.add_argument("--out", default="out", type=Path, help="Directory for the delivered files")
    return parser.parse_args(argv)


async def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # status messages are Unicode
    options = parse_args(argv)
    raw = options.args
    args = json.loads(Path(raw[1:]).read_text(encoding="utf-8") if raw.startswith("@") else raw)
    if options.url:
        server: Any = options.url
    else:
        command, *rest = shlex.split(options.stdio, posix=sys.platform != "win32")
        server = StdioServerParameters(command=command, args=rest)
    try:
        async with Client(server, extensions=[advertise(PROFILE, {"version": VERSION})]) as client:
            caps = client.server_capabilities  # extensions on 2026-07-28, experimental before (spec 2)
            if PROFILE not in (getattr(caps, "extensions", None) or caps.experimental or {}):
                print(f"note: server does not advertise {PROFILE}; relying on tool _meta", file=sys.stderr)
            await invoke(client, options.tool, args, options.out)
        return 0
    except JobEnded as exc:
        print(f"job ended without a payload: {exc}", file=sys.stderr)
        return 1
    except ProtocolError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
