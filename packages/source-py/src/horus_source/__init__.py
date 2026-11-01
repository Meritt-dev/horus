"""Horus source intelligence — Graph-powered code intelligence engine."""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("horus-source")
except PackageNotFoundError:
    __version__ = "0.0.0"
