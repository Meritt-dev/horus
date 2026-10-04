#!/usr/bin/env python3
"""Bounded GitHub CI observer: state changes only, one failed-log fetch per run."""
import argparse
import json
import subprocess
import time
from pathlib import Path


def gh(*args):
    return subprocess.check_output(["gh", *args], text=True, timeout=30)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo")
    parser.add_argument("run", type=int)
    parser.add_argument("--deadline", type=int, default=600)
    parser.add_argument("--interval", type=int, default=20)
    parser.add_argument("--state", type=Path)
    args = parser.parse_args()
    if not 1 <= args.deadline <= 3600 or not 5 <= args.interval <= 60:
        parser.error("deadline must be 1–3600s; interval must be 5–60s")
    identity = f"{args.repo}:{args.run}"
    state = {"identity": identity, "jobs": {}, "logsFetched": False}
    if args.state and args.state.exists():
        state = json.loads(args.state.read_text())
        if state.get("identity") != identity:
            parser.error("state belongs to another repository/run")
    end = time.monotonic() + args.deadline
    while time.monotonic() < end:
        try:
            run = json.loads(gh("run", "view", str(args.run), "--repo", args.repo,
                            "--json", "status,conclusion,headSha,jobs,url"))
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, json.JSONDecodeError) as error:
            print(f"CI observer unavailable ({type(error).__name__}); no run conclusion inferred.", flush=True)
            return 2
        for job in run["jobs"]:
            key = str(job["databaseId"])
            observed = [job["status"], job["conclusion"]]
            if state["jobs"].get(key) != observed:
                print(f"{job['name']}: {observed[0]} {observed[1] or ''}", flush=True)
                state["jobs"][key] = observed
        if run["status"] == "completed":
            if run["conclusion"] != "success" and not state["logsFetched"]:
                # Mark first: a lost continuation must not repeatedly dump logs.
                state["logsFetched"] = True
                if args.state:
                    args.state.write_text(json.dumps(state) + "\n")
                try:
                    print(gh("run", "view", str(args.run), "--repo", args.repo,
                             "--log-failed")[-12000:], flush=True)
                except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                    print("Failed logs unavailable; run conclusion remains authoritative.", flush=True)
            if args.state:
                args.state.write_text(json.dumps(state) + "\n")
            print(json.dumps({k: run[k] for k in ["url", "headSha", "conclusion"]}), flush=True)
            return 0 if run["conclusion"] == "success" else 1
        if args.state:
            args.state.write_text(json.dumps(state) + "\n")
        time.sleep(min(args.interval, max(0, end - time.monotonic())))
    print(f"CI still running after {args.deadline}s; retained state, no failure inferred.", flush=True)
    return 3


if __name__ == "__main__":
    raise SystemExit(main())
