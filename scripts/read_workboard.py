#!/usr/bin/env python3
"""Read the work Command Board through Hermes' authenticated Notion MCP bridge.

This helper is deliberately read-only.  It calls the fixed
``notion-query-data-sources`` tool through ``mcp.py``; it never accepts an MCP
tool name or a write payload from the caller.  The mirror invokes it with a
bounded subprocess timeout and consumes the JSON object printed on stdout.

The MCP SQL endpoint does not expose a useful cursor for this data source, so
the reader uses deterministic ``ORDER BY url`` pages with ``LIMIT/OFFSET``.
When the safety cap is reached the result says so explicitly.  Callers must
not treat a truncated result as a complete board.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from typing import Any


MCP_PATH = "/home/hermes/work-agent/notion-mcp/mcp.py"
DATA_SOURCE_URL = "collection://70dff988-c400-416b-ab81-950cea0ea987"
DEFAULT_PAGE_SIZE = 100
DEFAULT_MAX_ROWS = 1000
MAX_PAGE_SIZE = 200
MAX_ROWS = 5000


def _load_mcp():
    spec = importlib.util.spec_from_file_location("work_notion_mcp", MCP_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load MCP bridge: {MCP_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MCP = _load_mcp()


def _query_sql(sql: str) -> dict[str, Any]:
    """Execute one fixed-purpose, read-only SQL call and decode its payload."""
    response = MCP.rpc(
        "tools/call",
        {
            "name": "notion-query-data-sources",
            "arguments": {
                "data": {
                    "mode": "sql",
                    "data_source_urls": [DATA_SOURCE_URL],
                    "query": sql,
                }
            },
        },
    )
    if not isinstance(response, dict) or "result" not in response:
        raise RuntimeError("MCP returned no result")
    result = response["result"]
    if not isinstance(result, dict):
        raise RuntimeError("MCP returned an invalid result")
    if result.get("isError"):
        raise RuntimeError("Notion query failed")

    content = result.get("content") or []
    text = next((part.get("text") for part in content if isinstance(part, dict) and part.get("text")), None)
    if not text:
        raise RuntimeError("Notion query returned no content")
    try:
        payload = json.loads(text)
    except (TypeError, ValueError) as exc:
        raise RuntimeError("Notion query returned invalid JSON") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
        raise RuntimeError("Notion query returned no result rows")
    return payload


def read_rows(page_size: int = DEFAULT_PAGE_SIZE, max_rows: int = DEFAULT_MAX_ROWS) -> dict[str, Any]:
    """Read every available row up to ``max_rows`` and report coverage."""
    if not isinstance(page_size, int) or page_size < 1 or page_size > MAX_PAGE_SIZE:
        raise ValueError(f"page_size must be between 1 and {MAX_PAGE_SIZE}")
    if not isinstance(max_rows, int) or max_rows < 1 or max_rows > MAX_ROWS:
        raise ValueError(f"max_rows must be between 1 and {MAX_ROWS}")

    rows: list[dict[str, Any]] = []
    pages = 0
    offset = 0
    has_more = False
    while len(rows) < max_rows:
        limit = min(page_size, max_rows - len(rows))
        sql = (
            f'SELECT * FROM "{DATA_SOURCE_URL}" '
            f"ORDER BY url LIMIT {limit} OFFSET {offset}"
        )
        payload = _query_sql(sql)
        page = [row for row in payload["results"] if isinstance(row, dict)]
        pages += 1
        rows.extend(page)
        offset += len(page)

        # A full page still needs a follow-up query.  This makes an exact
        # page-boundary count complete even when the server's has_more hint is
        # absent or stale.
        server_more = bool(payload.get("has_more"))
        if len(page) < limit:
            has_more = False
            break
        has_more = server_more or len(page) == limit
        if not page:
            has_more = False
            break

    # Probe one row past the safety cap when the final page was full.  Without
    # this probe a board whose size is exactly max_rows would be reported as
    # truncated despite having complete coverage.
    if len(rows) >= max_rows and has_more:
        probe = _query_sql(
            f'SELECT url FROM "{DATA_SOURCE_URL}" '
            f"ORDER BY url LIMIT 1 OFFSET {max_rows}"
        )
        pages += 1
        has_more = bool(probe.get("results"))

    truncated = bool(has_more and len(rows) >= max_rows)
    return {
        "rows": rows[:max_rows],
        "coverage": {
            "complete": not truncated,
            "truncated": truncated,
            "pages": pages,
            "fetchedRows": min(len(rows), max_rows),
            "maxRows": max_rows,
        },
        "dataSource": DATA_SOURCE_URL,
    }


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--page-size", type=int, default=DEFAULT_PAGE_SIZE)
    parser.add_argument("--max-rows", type=int, default=DEFAULT_MAX_ROWS)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    try:
        args = _parse_args(argv if argv is not None else sys.argv[1:])
        print(json.dumps(read_rows(args.page_size, args.max_rows), separators=(",", ":")))
        return 0
    except Exception as exc:  # keep stderr useful while stdout remains JSON-only
        print(f"read_workboard.py failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
