"""
Download the full Cincinnati Fire Department CAD dataset (real 911 dispatch
data, including EMS ALS/BLS runs) from the city's Socrata open-data portal.

Unlike the Seattle and Montgomery County datasets used elsewhere in this repo,
this one has the FULL real CAD timestamp chain per incident:
  create_time_incident      -- call received
  dispatch_time_primary_unit -- unit dispatched
  arrival_time_primary_unit  -- unit arrived on scene
  closed_time_incident       -- incident closed

That means real response time (dispatch->arrival, or call->arrival) can be
computed directly -- no invented response-time model needed, unlike the
Montgomery County notebook (visualize.ipynb), which had no arrival timestamps
at all in the source data.

Source: https://data.cincinnati-oh.gov/Safety/Cincinnati-Fire-Incidents-CAD-including-EMS-ALS-BL/vnsz-a3wp
License: public, Socrata open data, no auth required.
"""
import time
from pathlib import Path

import pandas as pd
import requests

BASE = "https://data.cincinnati-oh.gov/resource/vnsz-a3wp.json"
OUT = Path(__file__).resolve().parent.parent / "data" / "cincinnati" / "cincinnati_cad_raw.csv"
PAGE = 50_000


def main():
    offset = 0
    frames = []
    while True:
        r = requests.get(BASE, params={"$limit": PAGE, "$offset": offset, "$order": "create_time_incident"}, timeout=60)
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        frames.append(pd.DataFrame(batch))
        print(f"  fetched offset={offset:>9,}  rows_this_batch={len(batch):>6,}")
        offset += PAGE
        if len(batch) < PAGE:
            break
        time.sleep(0.2)

    df = pd.concat(frames, ignore_index=True)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUT, index=False)
    print(f"\nWrote {OUT}  ({len(df):,} rows, {OUT.stat().st_size/1e6:.1f} MB)")
    print(f"Date range: {df['create_time_incident'].min()} -> {df['create_time_incident'].max()}")
    print(f"Columns: {list(df.columns)}")


if __name__ == "__main__":
    main()
