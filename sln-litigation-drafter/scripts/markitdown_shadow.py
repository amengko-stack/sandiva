"""Narrow, stdin-only MarkItDown worker for AI-02 shadow measurement."""

from __future__ import annotations

import io
import socket
import sys

from markitdown import MarkItDown, StreamInfo


class NetworkDeniedError(RuntimeError):
    pass


def _deny_network(*_args: object, **_kwargs: object) -> None:
    raise NetworkDeniedError("outbound network is disabled")


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"docx", "txt"}:
        return 2

    file_class = sys.argv[1]
    mime_type = {
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "txt": "text/plain",
    }[file_class]

    socket.create_connection = _deny_network  # type: ignore[assignment]
    socket.socket.connect = _deny_network  # type: ignore[method-assign]

    source = io.BytesIO(sys.stdin.buffer.read())
    converter = MarkItDown(enable_plugins=False)
    result = converter.convert_stream(
        source,
        stream_info=StreamInfo(
            extension=f".{file_class}",
            mimetype=mime_type,
            filename=f"shadow.{file_class}",
        ),
    )
    sys.stdout.write(result.markdown)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
