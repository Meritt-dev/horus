#!/usr/bin/env python3
"""Release gate: validate the companion's configured CLI production revision."""
import json
import re
import subprocess

from urllib.request import urlopen

with urlopen("https://api.horus.sh/v1/version", timeout=30) as response:
    config = json.loads(response.read(8192))
sha = config.get("pairedCliSha", "")
if not re.fullmatch(r"[a-f0-9]{40}", sha):
    raise ValueError("Deployed Cloud does not report a verified paired CLI revision")
subprocess.run(["git", "fetch", "--no-tags", "origin", sha], check=True, timeout=60)
subprocess.run(["git", "diff", "--quiet", sha, "HEAD", "--", "packages", "apps", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "turbo.json",
                ":(exclude)**/*.test.*"], check=True)
print(f"Cloud paired contract has the current CLI production source: {sha}")
