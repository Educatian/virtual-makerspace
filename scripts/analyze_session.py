#!/usr/bin/env python3
"""Analyze a Virtual Makerspace CPS telemetry NDJSON export.

Validates every line against schemas/telemetry-v1.json (JSON Schema draft
2020-12), then prints three blocks:

  1. SESSION SUMMARY    - identity, counts, durations, per-event_type table.
  2. CPS-SIGNAL TIMELINE - dyadic/CPS signal events in frame_time order, with
                           start/end pairing for joint-gaze and partner-orient.
  3. PISA SCAFFOLD TALLY - illustrative (NOT validated) 3x4 PISA-2015 12-cell
                           mapping of event_types to collaboration dim x stage.

USAGE
    python analyze_session.py <export.ndjson> [--schema PATH] [--strict]

    <export.ndjson>   NDJSON telemetry export (one JSON event per line).
    --schema PATH     Schema file (default: ../schemas/telemetry-v1.json
                      relative to this script).
    --strict          Exit nonzero if any line fails schema validation.

DEPENDENCIES
    Python stdlib + `jsonschema` (pip install jsonschema).

CAVEATS (see schema header + project spec):
    - Use frame_time_ms for within-client ordering/duration; timestamp_ms is
      wall-clock and only valid for cross-client alignment.
    - Each export is ONE client's view. partner_*/avatar_*/server_led_state are
      this client's observations, not the partner's authoritative actions. True
      dyadic CPS coding requires merging both participants' exports.
    - The PISA 12-cell mapping is a heuristic SCAFFOLD, not a validated coding
      scheme. Human coders / IRR are still required for publishable CPS coding.
"""

import argparse
import json
import os
import sys
from collections import Counter, defaultdict

try:
    from jsonschema import Draft202012Validator
except ImportError:  # pragma: no cover
    sys.stderr.write(
        "ERROR: this script requires the 'jsonschema' package "
        "(pip install jsonschema).\n"
    )
    sys.exit(2)


DEFAULT_SCHEMA = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "schemas", "telemetry-v1.json")
)

# ---------------------------------------------------------------------------
# PISA-2015 scaffold mapping
# ---------------------------------------------------------------------------
DIMS = [
    "A1 shared understanding",
    "A2 appropriate action",
    "A3 team organisation",
]
STAGES = [
    "S1 explore/understand",
    "S2 represent/formulate",
    "S3 plan/execute",
    "S4 monitor/reflect",
]

# Static event_type -> list of (dim_idx, stage_idx) contributions.
# Conditional events (step_advance, grab_start, handoff, led divergence) are
# handled in apply_pisa_mapping() below and intentionally omitted here.
STATIC_MAPPING = {
    "joint_gaze_start": [(0, 0)],            # A1xS1
    "joint_gaze_end": [(0, 0)],             # A1xS1
    "partner_orient_start": [(0, 0)],       # A1xS1
    "partner_orient_end": [(0, 0)],         # A1xS1
    "voice_speaking_state": [(0, 1)],       # A1xS2 (also A1xS4 if near circuit)
    "socket_connect": [(1, 1), (1, 2)],     # A2xS2 + A2xS3
    "socket_disconnect": [(1, 1)],          # A2xS2
    "led_state_change": [(1, 3)],           # A2xS4
    "circuit_closed_success": [(1, 3)],     # A2xS4
    "circuit_state_change": [(1, 3)],       # A2xS4
    "partner_join": [(0, 0), (2, 0)],       # A1xS1 + A3xS1
    "partner_leave": [(2, 0)],              # A3xS1
    "avatar_spawn": [(0, 0), (2, 0)],       # A1xS1 + A3xS1
    "avatar_despawn": [(2, 0)],             # A3xS1
    "ui_interaction": [],                   # only placement_guides -> A2xS1 (cond)
    "turn_take": [(0, 2), (2, 1)],          # A1xS3 (mid build) + A3xS2 (role alt)
    "server_led_state": [],                 # divergence handled conditionally
}

# Human-readable legend describing how each event maps (incl. conditionals).
MAPPING_LEGEND = {
    "joint_gaze_start": "A1xS1",
    "joint_gaze_end": "A1xS1",
    "partner_orient_start": "A1xS1",
    "partner_orient_end": "A1xS1",
    "voice_speaking_state": "A1xS2 (A1xS4 when co-occurring with circuit change)",
    "turn_take": "A1xS3 + A3xS2",
    "step_advance": "A1xS2 if step==0 else A2xS3",
    "grab_start": "A2xS1 if first-seen part_id else (generic action)",
    "grab_end": "A2xS3 when snapped=true",
    "socket_connect": "A2xS2 + A2xS3",
    "socket_disconnect": "A2xS2",
    "led_state_change": "A2xS4",
    "circuit_state_change": "A2xS4",
    "circuit_closed_success": "A2xS4",
    "ui_interaction": "A2xS1 when element_id=='placement_guides'",
    "partner_join": "A1xS1 + A3xS1",
    "partner_leave": "A3xS1",
    "avatar_spawn": "A1xS1 + A3xS1",
    "avatar_despawn": "A3xS1",
    "handoff": "A3xS3 (completed cross-participant transfer)",
    "server_led_state": "A3xS4 on divergence vs led_state_change",
    "session_end": "A3xS4",
}

# CPS-signal event_types for the timeline block.
TIMELINE_EVENTS = {
    "joint_gaze_start",
    "joint_gaze_end",
    "partner_orient_start",
    "partner_orient_end",
    "handoff",
    "turn_take",
    "voice_speaking_state",
}


# ---------------------------------------------------------------------------
# Loading / validation
# ---------------------------------------------------------------------------
def load_schema(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def read_and_validate(ndjson_path, validator):
    """Return (valid_events, invalid_records, total_lines).

    invalid_records is a list of (line_no, message, event_type-or-None).
    """
    valid = []
    invalid = []
    total = 0
    with open(ndjson_path, "r", encoding="utf-8") as fh:
        for line_no, raw in enumerate(fh, start=1):
            line = raw.strip()
            if not line:
                continue
            total += 1
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                invalid.append((line_no, "JSON parse error: %s" % exc, None))
                continue
            errors = sorted(
                validator.iter_errors(obj), key=lambda e: list(e.path)
            )
            if errors:
                etype = obj.get("event_type") if isinstance(obj, dict) else None
                first = errors[0]
                invalid.append((line_no, first.message, etype))
            else:
                valid.append(obj)
    return valid, invalid, total


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------
def fmt_mmss(ms):
    if ms is None:
        return "--:--.---"
    total_s = ms / 1000.0
    minutes = int(total_s // 60)
    seconds = total_s - minutes * 60
    return "%02d:%06.3f" % (minutes, seconds)


def payload_kv(payload):
    if not isinstance(payload, dict):
        return ""
    return " ".join("%s=%s" % (k, payload[k]) for k in payload)


# ---------------------------------------------------------------------------
# Block 1: session summary
# ---------------------------------------------------------------------------
def print_session_summary(valid, invalid, total):
    print("=" * 70)
    print("SESSION SUMMARY")
    print("=" * 70)

    first = valid[0] if valid else {}
    for key in (
        "session_id",
        "participant_id",
        "mode",
        "role",
        "room",
        "condition",
    ):
        print("  %-16s %s" % (key + ":", first.get(key, "<none>")))

    print("  %-16s %d" % ("total lines:", total))
    print("  %-16s %d" % ("valid events:", len(valid)))
    print("  %-16s %d" % ("invalid events:", len(invalid)))

    frame_times = [
        e["frame_time_ms"]
        for e in valid
        if isinstance(e.get("frame_time_ms"), (int, float))
    ]
    wall_times = [
        e["timestamp_ms"]
        for e in valid
        if isinstance(e.get("timestamp_ms"), (int, float))
    ]
    if frame_times:
        dur_s = (max(frame_times) - min(frame_times)) / 1000.0
        print("  %-16s %.3f  (frame_time_ms; authoritative)" % ("duration s:", dur_s))
    else:
        print("  %-16s n/a" % "duration s:")
    if wall_times:
        span_s = (max(wall_times) - min(wall_times)) / 1000.0
        print(
            "  %-16s %.3f  (timestamp_ms; cross-check only)"
            % ("wall span s:", span_s)
        )
    else:
        print("  %-16s n/a" % "wall span s:")

    # session_start / session_end presence warnings
    types_present = {e.get("event_type") for e in valid}
    if "session_start" not in types_present:
        print("  WARNING: no session_start event found in export.")
    if "session_end" not in types_present:
        print(
            "  WARNING: no session_end event (beforeunload may not have fired; "
            "common on headset/mobile)."
        )

    print()
    print("  counts per event_type (descending):")
    counts = Counter(e.get("event_type") for e in valid)
    for etype, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])):
        print("    %5d  %s" % (n, etype))

    if invalid:
        print()
        print("  invalid lines:")
        for line_no, msg, etype in invalid:
            label = etype if etype else "<unparsed>"
            print("    line %d [%s]: %s" % (line_no, label, msg))
    print()


# ---------------------------------------------------------------------------
# Block 2: CPS-signal timeline
# ---------------------------------------------------------------------------
def print_cps_timeline(valid):
    print("=" * 70)
    print("CPS-SIGNAL TIMELINE  (ordered by frame_time_ms)")
    print("=" * 70)

    signals = [e for e in valid if e.get("event_type") in TIMELINE_EVENTS]
    signals.sort(key=lambda e: e.get("frame_time_ms", 0.0))

    if not signals:
        print("  (no CPS-signal events present)")
        print()
        return

    # Track open starts for pairing: gaze keyed by (pid, target); orient by pid.
    open_gaze = {}
    open_orient = {}

    for e in signals:
        etype = e["event_type"]
        ft = e.get("frame_time_ms")
        payload = e.get("payload", {})
        line = "  [%s] %-22s %s" % (fmt_mmss(ft), etype, payload_kv(payload))

        if etype == "joint_gaze_start":
            key = (payload.get("partner_pid"), payload.get("target"))
            open_gaze[key] = ft
        elif etype == "joint_gaze_end":
            key = (payload.get("partner_pid"), payload.get("target"))
            start_ft = open_gaze.pop(key, None)
            if start_ft is None:
                line += "  [UNMATCHED end]"
            elif ft is not None:
                line += "  [computed_dur_ms=%.1f]" % (ft - start_ft)
        elif etype == "partner_orient_start":
            open_orient[payload.get("partner_pid")] = ft
        elif etype == "partner_orient_end":
            start_ft = open_orient.pop(payload.get("partner_pid"), None)
            if start_ft is None:
                line += "  [UNMATCHED end]"
            elif ft is not None:
                line += "  [computed_dur_ms=%.1f]" % (ft - start_ft)

        print(line)

    # Report leftover unmatched starts.
    for (pid, target), ft in open_gaze.items():
        print(
            "  [%s] joint_gaze_start UNMATCHED (no end) partner_pid=%s target=%s"
            % (fmt_mmss(ft), pid, target)
        )
    for pid, ft in open_orient.items():
        print(
            "  [%s] partner_orient_start UNMATCHED (no end) partner_pid=%s"
            % (fmt_mmss(ft), pid)
        )
    print()


# ---------------------------------------------------------------------------
# Block 3: PISA scaffold tally
# ---------------------------------------------------------------------------
def apply_pisa_mapping(valid):
    """Build the 3x4 tally matrix applying static + conditional rules."""
    matrix = [[0 for _ in STAGES] for _ in DIMS]
    seen_part_ids = set()

    # Pre-index for led/server_led divergence detection (A3xS4).
    # Heuristic: count a divergence whenever a server_led_state lit value differs
    # from the most recent local led_state_change lit value at that point.
    last_local_lit = None

    # Process in frame_time order so conditional/temporal rules are coherent.
    ordered = sorted(valid, key=lambda e: e.get("frame_time_ms", 0.0))

    for e in ordered:
        etype = e.get("event_type")
        payload = e.get("payload", {}) or {}

        # Static contributions.
        for (d, s) in STATIC_MAPPING.get(etype, []):
            matrix[d][s] += 1

        # Conditional rules.
        if etype == "step_advance":
            if payload.get("step") == 0:
                matrix[0][1] += 1  # A1xS2
            else:
                matrix[1][2] += 1  # A2xS3
        elif etype == "grab_start":
            pid = payload.get("part_id")
            if pid not in seen_part_ids:
                seen_part_ids.add(pid)
                matrix[1][0] += 1  # A2xS1 (first-seen part)
            # subsequent grabs: generic action, no specific cell increment
        elif etype == "grab_end":
            if payload.get("snapped") is True:
                matrix[1][2] += 1  # A2xS3
        elif etype == "handoff":
            # The emitter only logs handoff on a genuine cross-participant
            # ownership transfer within the handoff window, i.e. a completed
            # exchange -> A3xS3 (team organisation, plan/execute).
            matrix[2][2] += 1  # A3xS3
        elif etype == "ui_interaction":
            if payload.get("element_id") == "placement_guides":
                matrix[1][0] += 1  # A2xS1
        elif etype == "led_state_change":
            last_local_lit = payload.get("lit")
        elif etype == "server_led_state":
            server_lit = payload.get("lit")
            if last_local_lit is not None and server_lit != last_local_lit:
                matrix[2][3] += 1  # A3xS4 shared-state divergence
        elif etype == "session_end":
            matrix[2][3] += 1  # A3xS4 monitoring/reflecting close-out

    return matrix


def print_pisa_tally(valid):
    print("=" * 70)
    print("PISA-2015 12-CELL SCAFFOLD TALLY  (ILLUSTRATIVE, NOT VALIDATED)")
    print("=" * 70)
    print("  Heuristic event->cell mapping. Human coding / IRR still required.")
    print()

    matrix = apply_pisa_mapping(valid)

    # Header row of stage tags.
    col_w = 12
    header = " " * 28 + "".join("%-*s" % (col_w, "S%d" % (j + 1)) for j in range(len(STAGES)))
    print(header)
    for i, dim in enumerate(DIMS):
        tag = "A%d" % (i + 1)
        cells = "".join(
            "%-*s" % (col_w, "%s=%d" % ("A%dxS%d" % (i + 1, j + 1), matrix[i][j]))
            for j in range(len(STAGES))
        )
        print("  %-3s %-22s %s" % (tag, dim, cells))

    print()
    print("  Stage legend:")
    for j, stage in enumerate(STAGES):
        print("    S%d = %s" % (j + 1, stage))

    print()
    print("  event_type -> cell(s) contribution legend (scaffold):")
    for etype in sorted(MAPPING_LEGEND):
        print("    %-24s -> %s" % (etype, MAPPING_LEGEND[etype]))
    print()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Validate + analyze a Virtual Makerspace CPS telemetry "
        "NDJSON export."
    )
    parser.add_argument("ndjson", help="Path to the NDJSON telemetry export.")
    parser.add_argument(
        "--schema",
        default=DEFAULT_SCHEMA,
        help="Path to telemetry-v1.json schema (default: %(default)s).",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Exit nonzero if any line fails schema validation.",
    )
    args = parser.parse_args(argv)

    if not os.path.isfile(args.ndjson):
        sys.stderr.write("ERROR: NDJSON file not found: %s\n" % args.ndjson)
        return 2
    if not os.path.isfile(args.schema):
        sys.stderr.write("ERROR: schema file not found: %s\n" % args.schema)
        return 2

    schema = load_schema(args.schema)
    validator = Draft202012Validator(schema)

    valid, invalid, total = read_and_validate(args.ndjson, validator)

    print_session_summary(valid, invalid, total)
    print_cps_timeline(valid)
    print_pisa_tally(valid)

    if invalid:
        msg = "%d invalid line(s) out of %d." % (len(invalid), total)
        if args.strict:
            sys.stderr.write("STRICT FAIL: %s\n" % msg)
            return 1
        sys.stderr.write("WARNING: %s (analysis ran on valid lines only.)\n" % msg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
