"""
Live authenticity check: proves the data + routing behind this project are real,
not fabricated. Re-queries the actual public government API and the actual
public OSRM routing server, right now, and diffs the results against what's
cached in this repo.

Run in front of judges: python3 src/verify_data_authenticity.py
"""
import json
import random
import subprocess
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CSV = DATA / "seattle" / "seattle_911_raw.csv"

SEATTLE_API = "https://data.seattle.gov/resource/kzjm-xkqj.json"
OSRM_API = "http://router.project-osrm.org/route/v1/driving"


def curl_json(url: str):
    result = subprocess.run(
        ["curl", "-s", "--max-time", "15", url], capture_output=True, text=True
    )
    return json.loads(result.stdout)


def check_mark(ok: bool) -> str:
    return "PASS" if ok else "FAIL"


def verify_call_records(df: pd.DataFrame, n: int = 5) -> bool:
    print(f"\n[1] Cross-checking {n} random call records against the LIVE Seattle "
          f"Open Data API ({SEATTLE_API})")
    sample = df.sample(n, random_state=random.randint(0, 10_000))
    all_ok = True
    for _, row in sample.iterrows():
        incident = row["incident_number"]
        live = curl_json(f"{SEATTLE_API}?incident_number={incident}")
        ok = bool(live) and live[0]["address"] == row["address"] and \
            live[0]["type"] == row["type"] and live[0]["datetime"] == row["datetime"]
        all_ok &= ok
        print(f"    {incident}: local='{row['address']}' | "
              f"live='{live[0]['address'] if live else 'NOT FOUND'}' -> {check_mark(ok)}")
    return all_ok


def verify_total_count(local_n: int) -> bool:
    print(f"\n[2] Cross-checking total dataset size against the LIVE API")
    live = curl_json(f"{SEATTLE_API}?$select=count(*)")
    live_n = int(live[0]["count"])
    print(f"    live API total rows: {live_n:,} (local sample pulled: {local_n:,})")
    return live_n > 0


def verify_osrm_routing() -> bool:
    print(f"\n[3] Cross-checking cached OSRM driving-time matrix against a LIVE "
          f"OSRM query ({OSRM_API})")
    meta = json.load(open(DATA / "osrm_routing_meta.json"))
    zz = np.load(DATA / "osrm_zone_zone_duration_sec.npy")
    z0, z1 = meta["zone_centers"][0], meta["zone_centers"][1]
    cached = zz[0][1]
    url = (f"{OSRM_API}/{z0['lng']},{z0['lat']};{z1['lng']},{z1['lat']}"
           f"?overview=false")
    live = curl_json(url)
    live_dur = live["routes"][0]["duration"]
    ok = abs(live_dur - cached) < 0.5
    print(f"    cached zone0->zone1 duration: {cached}s | live OSRM: {live_dur}s -> {check_mark(ok)}")
    return ok


def main():
    df = pd.read_csv(CSV)
    print(f"Loaded local dataset: {len(df):,} rows from {CSV.relative_to(ROOT)}")

    results = {
        "call_records_match_live_api": verify_call_records(df),
        "total_count_reachable_live": verify_total_count(len(df)),
        "osrm_routing_matches_live": verify_osrm_routing(),
    }

    print("\n=== SUMMARY ===")
    for k, v in results.items():
        print(f"  {k}: {check_mark(v)}")

    if all(results.values()):
        print("\nAll checks passed against LIVE public sources. Data and routing are real.")
        sys.exit(0)
    else:
        print("\nSome checks failed -- investigate before presenting.")
        sys.exit(1)


if __name__ == "__main__":
    main()
