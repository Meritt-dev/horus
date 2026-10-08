#!/usr/bin/env python3
"""Validate one current release receipt and derive its acceptance summary."""
import argparse
import json
import hashlib
import re
import subprocess
from datetime import datetime, timedelta
from pathlib import Path


def validate(data):
    if not (set(data) == {"version", "observedAt", "cli", "cloud", "ci", "soak", "gates"}):
        raise ValueError("Unknown receipt fields")
    if not (data["version"] == 1):
        raise ValueError("Invalid receipt")
    datetime.fromisoformat(data["observedAt"].replace("Z", "+00:00"))
    if not (set(data["cli"]) == {"sourceSha", "artifactSha256", "artifactOrigin"}):
        raise ValueError("Invalid receipt")
    if not (set(data["cloud"]) == {"sourceSha", "imageDigest", "version", "pairedCliSha", "verifiedSha"}):
        raise ValueError("Invalid receipt")
    for sha in [data["cli"]["sourceSha"], data["cloud"]["sourceSha"], data["cloud"]["pairedCliSha"], data["cloud"]["verifiedSha"]]:
        if not (re.fullmatch(r"[a-f0-9]{40}", sha)):
            raise ValueError("Invalid source identity")
    if not (re.fullmatch(r"[a-f0-9]{64}", data["cli"]["artifactSha256"])):
        raise ValueError("Invalid receipt")
    if not (data["cli"]["artifactOrigin"] in {"local-build-from-ci-source", "hosted-ci-artifact"}):
        raise ValueError("Invalid receipt")
    if not (re.fullmatch(r"sha256:[a-f0-9]{64}", data["cloud"]["imageDigest"])):
        raise ValueError("Invalid receipt")
    if not (re.fullmatch(r"\d+\.\d+\.\d+", data["cloud"]["version"])):
        raise ValueError("Invalid receipt")
    if not (data["ci"] and isinstance(data["ci"], list)):
        raise ValueError("Invalid receipt")
    for run in data["ci"]:
        if not (set(run) == {"repo", "runId", "headSha", "conclusion"}):
            raise ValueError("Invalid receipt")
        if not (run["repo"] in {"Meritt-dev/horus", "Meritt-dev/horus-cloud"}):
            raise ValueError("Invalid receipt")
        if not (type(run["runId"]) is int and run["runId"] > 0):
            raise ValueError("Invalid receipt")
        if not (re.fullmatch(r"[a-f0-9]{40}", run["headSha"])):
            raise ValueError("Invalid receipt")
        if not (run["conclusion"] in {"success", "failure", "pending", "unavailable"}):
            raise ValueError("Invalid receipt")
    if not (set(data["soak"]) == {"startedAt", "requiredHours"}):
        raise ValueError("Invalid receipt")
    start = datetime.fromisoformat(data["soak"]["startedAt"].replace("Z", "+00:00"))
    if not (start.tzinfo and data["soak"]["requiredHours"] == 72):
        raise ValueError("Invalid receipt")
    if not (set(data["gates"]) == {"nativeDelivery", "measuredRates", "scenarioSoak"}):
        raise ValueError("Invalid receipt")
    for passed in data["gates"].values():
        if not (type(passed) is bool):
            raise ValueError("Invalid receipt")
    for repo, sha in [("Meritt-dev/horus", data["cli"]["sourceSha"]),
                      ("Meritt-dev/horus-cloud", data["cloud"]["verifiedSha"])]:
        if not any(run["repo"] == repo and run["headSha"] == sha for run in data["ci"]):
            raise ValueError("CI evidence must cover both recorded source revisions")
    return start + timedelta(hours=72)


def summary(data):
    cutoff = validate(data)
    lines = ["# Current service acceptance", "", "Generated from current-release.json; do not edit this summary by hand.", "",
             f"Observed: {data['observedAt']}", "",
             f"- CLI source: `{data['cli']['sourceSha']}`", f"- Artifact SHA-256: `{data['cli']['artifactSha256']}`",
             f"- Artifact origin: `{data['cli']['artifactOrigin']}`", f"- Cloud API: `{data['cloud']['version']}` / `{data['cloud']['sourceSha']}`",
             f"- Cloud verified source: `{data['cloud']['verifiedSha']}`", f"- Cloud image: `{data['cloud']['imageDigest']}`", f"- Paired CLI contract: `{data['cloud']['pairedCliSha']}`", "", "Hosted CI:", ""]
    for run in data["ci"]:
        lines.append(f"- [{run['repo']} run {run['runId']}](https://github.com/{run['repo']}/actions/runs/{run['runId']}): {run['conclusion']} on `{run['headSha']}`")
    lines += ["", f"Soak anchor: {data['soak']['startedAt']}. Earliest elapsed cutoff: {cutoff.isoformat()}.",
              "Time alone does not establish scenario coverage. Earlier manual actions retain their original revision scope.", "", "Release gates:", ""]
    for gate, passed in data["gates"].items():
        lines.append(f"- {gate}: {'verified' if passed else 'unverified'}")
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["render", "check", "release", "artifact"])
    parser.add_argument("receipt", type=Path)
    parser.add_argument("--artifact", type=Path, default=Path("apps/horus/dist/index.cjs"))
    args = parser.parse_args()
    data = json.loads(args.receipt.read_text())
    generated = args.receipt.with_suffix(".md")
    text = summary(data)
    if args.action == "render":
        generated.write_text(text)
    else:
        if not (generated.read_text() == text):
            raise ValueError("Current summary differs from receipt; render it")
    if args.action == "artifact":
        if hashlib.sha256(args.artifact.read_bytes()).hexdigest() != data["cli"]["artifactSha256"]:
            raise ValueError("Built artifact differs from accepted runtime")
    if args.action == "release":
        if not (all(data["gates"].values())):
            raise ValueError("Public service release gates remain unverified")
        if not (datetime.now(validate(data).tzinfo) >= validate(data)):
            raise ValueError("72-hour window has not elapsed")
        if not (all(run["conclusion"] == "success" for run in data["ci"])):
            raise ValueError("CI evidence incomplete")
        from urllib.request import urlopen
        with urlopen("https://api.horus.sh/v1/version", timeout=30) as response:
            live = json.loads(response.read(8192))
        if (live.get("buildSourceSha"), live.get("verifiedSourceSha"), live.get("pairedCliSha")) != (data["cloud"]["sourceSha"], data["cloud"]["verifiedSha"], data["cloud"]["pairedCliSha"]):
            raise ValueError("Deployed Cloud differs from receipt")
        # A receipt cannot authorize publication of different production source.
        subprocess.run(["git", "diff", "--quiet", data["cli"]["sourceSha"], "HEAD", "--",
                        "packages", "apps", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", ".npmrc", "turbo.json", ":(exclude)**/*.test.*"], check=True)


if __name__ == "__main__":
    main()
