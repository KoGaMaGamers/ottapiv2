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

# Secret-bearing query params. Matched plain (`password=x`) and
# percent-encoded inside another URL (`url=...%3Fpassword%3Dx%26...`, as in
# /user/stream-proxy?url=...). `token` is the 30-day session token that
# media URLs carry in the query string; `api_key` is e.g. SubDL's.
_SECRET_KEYS = r"username|password|token|access_token|api_key|apikey"
_QUERY_RE = re.compile(
    r"(?i)(?:\b|(?<=%3F)|(?<=%26))(" + _SECRET_KEYS + r")(=|%3D)(.*?)(?=&|%26|[\s'\")]|$)"
)
_PATH_RE = re.compile(r"/(live|movie|series|timeshift)/([^/\s?]+)/([^/\s?]+)/")
_PATH_ENC_RE = re.compile(
    r"(?i)%2F(live|movie|series|timeshift)%2F(.+?)%2F(.+?)%2F"
)


def redact(text: str) -> str:
    if not text:
        return text
    text = _QUERY_RE.sub(r"\1\2***", text)
    text = _PATH_ENC_RE.sub(r"%2F\1%2F***%2F***%2F", text)
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
