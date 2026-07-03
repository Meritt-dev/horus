"""Process routes — list discovered execution processes with their steps."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query, Request

from horus_source.core.classify import is_test_path

logger = logging.getLogger(__name__)

router = APIRouter(tags=["processes"])


@router.get("/processes")
def get_processes(request: Request) -> dict:
    """Query all Process nodes and their ordered steps."""
    storage = request.app.state.storage

    try:
        rows = storage.get_processes_with_steps()
    except Exception as exc:
        logger.error("Processes query failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail="Processes query failed") from exc

    if not rows:
        return {"processes": []}

    processes = []
    for row in rows:
        try:
            _, pname, node_ids, step_numbers = row
        except (ValueError, IndexError) as e:
            logger.debug("Row unpacking failed: %s", e)
            continue
        steps = sorted(
            [{"nodeId": nid, "stepNumber": sn} for nid, sn in zip(node_ids or [], step_numbers or [])],
            key=lambda s: (s["stepNumber"] is None, s["stepNumber"] or 0),
        )
        processes.append({
            "name": pname,
            "kind": None,
            "stepCount": len(steps),
            "steps": steps,
        })

    return {"processes": processes}


@router.get("/flows/{node_id:path}")
def get_flows(
    node_id: str,
    request: Request,
    include_tests: bool = Query(default=False),
) -> dict:
    """Return the process flows a symbol participates in, with each flow's ordered steps.

    Unlike GET /processes, the steps carry their symbol names (and file/line), so the
    CLI can render a flow without a second round-trip. Product mode (the default)
    omits steps living in test files — flows built by indexes predating the
    test-entry-point filter still carry them; ``include_tests=true`` restores all.
    """
    if len(node_id) > 500:
        raise HTTPException(status_code=400, detail="Node ID too long")

    storage = request.app.state.storage
    try:
        flows = storage.flows_for_symbol(node_id)
    except Exception as exc:
        logger.error("Flows query failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail="Flows query failed") from exc

    processes = flows.get("processes", []) if flows else []
    raw_steps = flows.get("steps", []) if flows else []
    if not include_tests:
        raw_steps = [
            s for s in raw_steps if not is_test_path(s.get("file_path", "") or "")
        ]
        if not raw_steps:
            processes = []
    steps = [
        {
            "nodeId": s.get("id", ""),
            "name": s.get("name", ""),
            "filePath": s.get("file_path", ""),
            "startLine": s.get("start_line", 0),
            "stepNumber": s.get("step_number"),
        }
        for s in raw_steps
    ]
    return {"processes": processes, "steps": steps}
