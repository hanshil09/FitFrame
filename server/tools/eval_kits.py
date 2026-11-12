"""Scan IKEA-Manual kits through the running server and score Gemini's step mapping
against the dataset's annotated steps (steps.json).

    .venv/bin/python server/tools/eval_kits.py im-chair-stig im-bench-hemnes ...
    .venv/bin/python server/tools/eval_kits.py --score results.json      # re-score saved scans

Each scan costs 1 Gemini call (the PDF is matched to its kit by hash).

The annotation groups the build into a few coarse joins, not the printed steps, and its page
numbers do not line up with the PDF, so only install order is comparable:
  order    - share of part pairs whose relative install order matches the annotation
  unmapped - parts Gemini never installs
  steps    - printed steps Gemini found (for reference)
"""
import json
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen

KITS = Path(__file__).resolve().parents[2] / "samples" / "ikea-kits"
SERVER = "http://localhost:8765"


def scan(key):
    pdf = (KITS / key / "manual.pdf").read_bytes()
    boundary = "----kitseval"
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"manual.pdf\"\r\n"
            f"Content-Type: application/pdf\r\n\r\n").encode() + pdf + f"\r\n--{boundary}--\r\n".encode()
    request = Request(f"{SERVER}/api/kits/scan", data=body,
                      headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    started = time.time()
    try:
        with urlopen(request, timeout=600) as response:
            result = json.load(response)
    except Exception as error:  # keep going with the other kits
        detail = getattr(error, "read", lambda: b"")().decode(errors="ignore")
        return {"error": f"{error} {detail}".strip(), "seconds": round(time.time() - started)}
    result["seconds"] = round(time.time() - started)
    return result


def truth(key):
    data = json.loads((KITS / key / "steps.json").read_text())
    first, pages = {}, []
    for index, step in enumerate(data["steps"]):
        pages.append(step["page"])
        for group in step["parts"]:
            for part in map(int, group.split(",")):
                first.setdefault(part, index)
    return first, pages


def score(key, result):
    if "error" in result:
        return {"kit": key, "error": result["error"][:160]}
    first, pages = truth(key)
    actions = result["plan"]["actions"]
    labels = list(dict.fromkeys(a["step"] for a in actions))     # printed step labels in order
    order = {label: i for i, label in enumerate(labels)}
    got = {}
    for action in actions:
        for node in action["nodes"]:
            got.setdefault(node, order[action["step"]])
    parts = list(first)
    # pairs the annotation puts in different joins; Gemini agrees if it installs them in the same order
    pairs = [(a, b) for a in parts for b in parts if a < b and first[a] != first[b]]
    agree = sum(1 for a, b in pairs if a in got and b in got
                and (got[a] - got[b]) * (first[a] - first[b]) > 0)
    return {
        "kit": key,
        "order": round(agree / len(pairs), 2) if pairs else 1.0,
        "steps": len(labels),
        "unmapped": sum(p not in got for p in parts),
        "unresolved": len(result["plan"]["unresolved"]),
        "seconds": result["seconds"],
        "model": result.get("provider"),
    }


def main(args):
    if args[:1] == ["--score"]:
        results = json.loads(Path(args[1]).read_text())
    else:
        results = {}
        for key in args:
            print(f"scanning {key}…", flush=True)
            for attempt in range(3):   # the server fails fast when Gemini is overloaded; give it a moment
                results[key] = scan(key)
                if "503" not in results[key].get("error", ""):
                    break
                time.sleep(30)
        out = Path("eval-results.json")
        out.write_text(json.dumps(results, indent=1))
        print(f"saved raw results to {out.resolve()}")
    rows = [score(k, r) for k, r in results.items()]
    for row in rows:
        print(json.dumps(row))


if __name__ == "__main__":
    main(sys.argv[1:])
