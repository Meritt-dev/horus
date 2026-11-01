"""Horus configuration — ignore patterns and language detection."""

from horus_source.config.ignore import DEFAULT_IGNORE_PATTERNS, load_gitignore, should_ignore
from horus_source.config.languages import SUPPORTED_EXTENSIONS, get_language, is_supported

__all__ = [
    "DEFAULT_IGNORE_PATTERNS",
    "SUPPORTED_EXTENSIONS",
    "get_language",
    "is_supported",
    "load_gitignore",
    "should_ignore",
]
