"""Run extraction on a manual from the command line: .venv/bin/python server/extract_cli.py samples/rta-0097m.pdf out.json"""
import json, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parent.parent / ".env")
import pipeline
from providers import make_provider

src, out = sys.argv[1], sys.argv[2]
t0 = time.time()
prov = make_provider()
plan, _ = pipeline.run(prov, [(src, Path(src).read_bytes())], lambda m: print(f"[{time.time()-t0:5.1f}s] {m}", flush=True))
plan["usage"] = {"model": prov.model, "calls": prov.calls, "tokens_in": prov.tokens_in, "tokens_out": prov.tokens_out}
Path(out).write_text(json.dumps(plan, indent=2))
print("calls", prov.calls, "in", prov.tokens_in, "out", prov.tokens_out)
