"""Mask Xtream credentials in log output.

Provider URLs carry credentials in two forms:
  - query string:  player_api.php?username=U&password=P
  - stream path:   /live/U/P/123.m3u8  (also movie/series/timeshift)

``redact`` masks both. ``RedactingFilter`` applies it to every record that
passes through a handler, so third-party exception text (requests embeds the
full URL) is covered too.
"""

import logging
import re

_QUERY_RE = re.compile(r"(?i)\b(username|password)=([^&\s'\")]+)")
_PATH_RE = re.compile(r"/(live|movie|series|timeshift)/([^/\s?]+)/([^/\s?]+)/")


def redact(text: str) -> str:
    if not text:
        return text
    text = _QUERY_RE.sub(r"\1=***", text)
    return _PATH_RE.sub(r"/\1/***/***/", text)


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:
            return True
        clean = redact(msg)
        if clean != msg:
            record.msg = clean
            record.args = None
        if record.exc_info and not record.exc_text:
            # Pre-render the traceback so the redacted text is what gets cached.
            record.exc_text = redact(logging.Formatter().formatException(record.exc_info))
        elif record.exc_text:
            record.exc_text = redact(record.exc_text)
        return True


def install(logger_names=("", "uvicorn", "uvicorn.error", "uvicorn.access")) -> None:
    """Attach the filter to every handler of the given loggers (idempotent)."""
    for name in logger_names:
        for handler in logging.getLogger(name).handlers:
            if not any(isinstance(f, RedactingFilter) for f in handler.filters):
                handler.addFilter(RedactingFilter())
