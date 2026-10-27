#!/usr/bin/env python3

import json
import re
import sys
from pathlib import Path


CODE_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]{0,127}$")
MAX_PARSE_BYTES = 64 * 1024


def omitted(size: int | str) -> str:
    return f"<unexpected response omitted; bytes={size}>"


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: safe-api-error-excerpt.py <response-file>", file=sys.stderr)
        return 2

    path = Path(sys.argv[1])
    try:
        size = path.stat().st_size
    except OSError:
        print(omitted("unknown"))
        return 0
    if size > MAX_PARSE_BYTES:
        print(omitted(size))
        return 0

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        error = payload["error"]
        code = error["code"]
    except (OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError):
        print(omitted(size))
        return 0

    if not isinstance(payload, dict) or not isinstance(error, dict) or not isinstance(code, str) or not CODE_PATTERN.fullmatch(code):
        print(omitted(size))
        return 0

    print(json.dumps({
        "error": {"code": code},
        "body": "<omitted>",
        "bodyBytes": size,
    }, ensure_ascii=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
