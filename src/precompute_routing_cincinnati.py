"""
Cincinnati version of precompute_routing.py -- same OSRM zone-to-zone /
zone-to-call precompute, run against real Cincinnati Fire Dept CAD data
(data/cincinnati/cincinnati_cad_raw.csv, fetched by fetch_cincinnati.py)
instead of Seattle's 911 feed.

Filter note: cfd_incident_type (ALS/BLS) is populated by a post-hoc coding
process and is ~96% NULL for the most recent months (coding lag), so it
can't be used to select a recent 60-day window. incident_type_id is
populated at CAD-entry time instead; EMS calls are selected via a keyword
match against it (same disclosed-heuristic approach used for Seattle's
`type` field), not a perfect classification.
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.cluster import KMeans

from osrm_routing import osrm_table

DATA_CSV = Path(__file__).resolve().parent.parent / "data" / "cincinnati" / "cincinnati_cad_raw.csv"
OUT_DIR = Path(__file__).resolve().parent.parent / "data" / "cincinnati"
K_ZONES = 20
SIM_DAYS = 60

EMS_KEYWORDS = [
    "EMS", "SICK", "FALL", "CHESTPN", "BREATH", "SEIZURE", "ABDOM", "PERDWN",
    "FAINT", "LIFT", "DOMINJ", "ASSLTI", "BLEED", "STROKE", "DIAB", "PREG",
    "CARDIAC", "UNCONSC", "OD", "POISON", "BURN", "STAB", "GSW", "MVA", "MVI",
]


def load_calls() -> pd.DataFrame:
    df = pd.read_csv(DATA_CSV, usecols=[
        "latitude_x", "longitude_x", "create_time_incident", "incident_type_id",
    ])
    df = df.rename(columns={"latitude_x": "latitude", "longitude_x": "longitude"})
    pattern = "|".join(EMS_KEYWORDS)
    df = df[df["incident_type_id"].str.contains(pattern, case=False, na=False)].copy()
    df = df.dropna(subset=["latitude", "longitude", "create_time_incident"])
    # Cincinnati proper bounding box -- drop stray bad geocodes.
    df = df[df["latitude"].between(38.95, 39.30) & df["longitude"].between(-84.75, -84.30)]
    df["datetime"] = pd.to_datetime(df["create_time_incident"], errors="coerce")
    df = df.dropna(subset=["datetime"]).sort_values("datetime")

    end = df["datetime"].max()
    start = end - pd.Timedelta(days=SIM_DAYS)
    df = df[(df["datetime"] >= start) & (df["datetime"] <= end)].reset_index(drop=True)
    return df


def main():
    OUT_DIR.mkdir(exist_ok=True, parents=True)
    calls = load_calls()
    print(f"Loaded {len(calls):,} real Cincinnati EMS calls for routing precompute "
          f"({calls['datetime'].min()} to {calls['datetime'].max()})")

    zone_model = KMeans(n_clusters=K_ZONES, n_init=10, random_state=42)
    zone_model.fit(calls[["latitude", "longitude"]])
    zone_centers = zone_model.cluster_centers_

    zone_lonlat = [(z[1], z[0]) for z in zone_centers]

    print("Fetching zone-to-zone matrix (20x20)...")
    zz_dur, zz_dist = osrm_table(zone_lonlat, zone_lonlat)
    np.save(OUT_DIR / "osrm_zone_zone_duration_sec.npy", np.array(zz_dur))
    np.save(OUT_DIR / "osrm_zone_zone_distance_m.npy", np.array(zz_dist))
    print("  done.")

    call_lonlat = list(zip(calls["longitude"].values, calls["latitude"].values))
    print(f"Fetching zone-to-call matrix (20 x {len(call_lonlat):,})...")
    zc_dur, zc_dist = osrm_table(zone_lonlat, call_lonlat)
    np.save(OUT_DIR / "osrm_zone_call_duration_sec.npy", np.array(zc_dur))
    np.save(OUT_DIR / "osrm_zone_call_distance_m.npy", np.array(zc_dist))
    print("  done.")

    meta = {
        "k_zones": K_ZONES,
        "n_calls": len(calls),
        "zone_centers": [{"lat": float(z[0]), "lng": float(z[1])} for z in zone_centers],
        "source": "OSRM public demo server (router.project-osrm.org), driving profile",
    }
    with open(OUT_DIR / "osrm_routing_meta.json", "w") as f:
        json.dump(meta, f, indent=2)

    # Also cache the exact call rows used, so simulate step doesn't re-filter differently.
    calls.to_csv(OUT_DIR / "calls_60d.csv", index=False)

    print("\nWrote:")
    print(f"  {OUT_DIR / 'osrm_zone_zone_duration_sec.npy'}  shape {np.array(zz_dur).shape}")
    print(f"  {OUT_DIR / 'osrm_zone_call_duration_sec.npy'}  shape {np.array(zc_dur).shape}")
    print(f"  {OUT_DIR / 'calls_60d.csv'}  {len(calls):,} rows")


if __name__ == "__main__":
    main()
