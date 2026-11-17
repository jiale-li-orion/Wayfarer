#!/usr/bin/env python3
"""Read-only, bounded collector benchmark. Run in the development checkout."""
import argparse, json, os, sys, time, subprocess, importlib.util, statistics
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument("--output", required=True)
p.add_argument("--samples", type=int, default=13)
p.add_argument("--interval", type=float, default=5)
p.add_argument("--compare-gpu", action="store_true")
a = p.parse_args()
root = Path(__file__).resolve().parents[1]
helper = root / "helpers/monitor.py"
result = {"at": time.time(), "samples": []}
if a.compare_gpu:
    if sys.platform == "win32":
        raise SystemExit(
            "GPU CPU-time comparison uses Linux getrusage; protocol profiling below is portable"
        )
    import resource

    spec = importlib.util.spec_from_file_location("wm_monitor", str(helper))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    nvml = m.NVML

    def cpu():
        x = resource.getrusage(resource.RUSAGE_SELF)
        y = resource.getrusage(resource.RUSAGE_CHILDREN)
        return x.ru_utime + x.ru_stime + y.ru_utime + y.ru_stime

    result["gpuComparison"] = {}
    try:
        for name, library in [("nvidia-smi", None), ("NVML", nvml)]:
            if name == "NVML" and library is None:
                continue
            m.NVML = library
            rows = []
            for i in range(5):
                start = time.perf_counter()
                before = cpu()
                g, apps, errors = m.gpu_query(True)
                rows.append(
                    {
                        "cpuMs": (cpu() - before) * 1000,
                        "wallMs": (time.perf_counter() - start) * 1000,
                        "gpus": len(g),
                        "gpuProcesses": len(apps),
                        "errors": errors,
                    }
                )
            result["gpuComparison"][name] = {
                "samples": rows,
                "medianCpuMs": statistics.median(x["cpuMs"] for x in rows),
                "medianWallMs": statistics.median(x["wallMs"] for x in rows),
            }
    finally:
        if nvml:
            nvml.close()
process = subprocess.Popen(
    [sys.executable, "-u", str(helper)],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    universal_newlines=True,
)
try:
    start = time.monotonic()
    for i in range(a.samples):
        if i:
            time.sleep(max(0, start + i * a.interval - time.monotonic()))
        process.stdin.write(
            json.dumps(
                {
                    "id": i,
                    "method": "snapshot",
                    "args": {"section": "processes", "limit": 50},
                }
            )
            + "\n"
        )
        process.stdin.flush()
        line = process.stdout.readline()
        if not line:
            raise RuntimeError("Collector exited")
        response = json.loads(line)
        if "error" in response:
            raise RuntimeError(response["error"])
        r = response["result"]
        result["samples"].append(
            {
                "stamp": r["stamp"],
                "collector": r["collector"],
                "processCount": r["total"],
                "responseBytes": len(line.encode("utf-8")),
                "gpuCount": len(r["gpus"]),
            }
        )
    first, last = result["samples"][0], result["samples"][-1]
    duration = (last["stamp"] - first["stamp"]) / 1000
    result["summary"] = {
        "seconds": duration,
        "cpuOneCorePercent": 100
        * (last["collector"]["cpuSeconds"] - first["collector"]["cpuSeconds"])
        / duration,
        "medianSampleMs": statistics.median(
            s["collector"]["elapsedMs"] for s in result["samples"]
        ),
        "medianResponseBytes": statistics.median(
            s["responseBytes"] for s in result["samples"]
        ),
        "processCount": last["processCount"],
        "rssLastMiB": last["collector"]["rss"] / 2**20,
    }
finally:
    process.stdin.close()
    process.wait(timeout=10)
    Path(a.output).write_text(json.dumps(result, indent=2))
print(json.dumps(result.get("summary", {})))
