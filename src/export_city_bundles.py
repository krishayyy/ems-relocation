"""
Export one uniform "city bundle" JSON per city for the web simulator.

The point of this script is that BOTH cities go through the *identical* model
code -- it imports mexclp_compliance_table() and run_simulation() straight out
of simulate_dynamic.py rather than reimplementing them, and only swaps the
inputs (real call stream + real precomputed OSRM matrices) per city. That is
the whole claim the simulator makes on screen: point the same model at a new
city's CAD data and it re-derives everything.

To guard that claim, the script re-runs each city and ASSERTS the headline
numbers it reproduces match the already-committed per-city result files
(data/dynamic_sim_seattle.json, data/cincinnati/dynamic_sim_cincinnati.json).
If a refactor ever changes the math, this fails loudly instead of quietly
shipping different numbers to the demo.

Bundle contents (all derived from real data, no invented values):
  summary            headline stats, incl. Wilcoxon p-value
  zones              zone centers + real call share
  compliance_table   MEXCLP ranking
  home_bases         staged posts (+ reverse-geocoded street address when known)
  hist               response-time distributions, static vs dynamic
  cumulative         downsampled cumulative avg response + total minutes saved
  race               busiest-day paired event traces for the head-to-head replay

Run:  python3 src/export_city_bundles.py
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import wilcoxon

sys.path.insert(0, str(Path(__file__).resolve().parent))
import simulate_dynamic as sd  # noqa: E402  (shared model code -- single source of truth)

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT_DIR = DATA / "bundles"

RNG_SEED = 42
HIST_MAX_MIN = 40
CUMULATIVE_POINTS = 240


def load_seattle_calls():
    return sd.load_calls()


def load_cincinnati_calls():
    return (pd.read_csv(DATA / "cincinnati" / "calls_60d.csv", parse_dates=["datetime"])
            .sort_values("datetime").reset_index(drop=True))


CITIES = {
    "seattle": {
        "name": "Seattle, WA",
        "short": "Seattle",
        "blurb": "Seattle Fire Department 911 call log",
        "source_url": "https://data.seattle.gov/",
        "routing_dir": DATA,
        "calls": load_seattle_calls,
        "n_ambulances": 16,
        "k_zones": 20,
        "addresses": DATA / "home_addresses.json",
        "expect": DATA / "dynamic_sim_seattle.json",
        "has_measured_response": False,
    },
    "cincinnati": {
        "name": "Cincinnati, OH",
        "short": "Cincinnati",
        "blurb": "Cincinnati Fire Department CAD export",
        "source_url": "https://data.cincinnati-oh.gov/",
        "routing_dir": DATA / "cincinnati",
        "calls": load_cincinnati_calls,
        "n_ambulances": 26,
        "k_zones": 20,
        "addresses": DATA / "cincinnati" / "home_addresses.json",
        "expect": DATA / "cincinnati" / "dynamic_sim_cincinnati.json",
        "has_measured_response": True,
    },
}


def load_routing(routing_dir: Path):
    meta = json.load(open(routing_dir / "osrm_routing_meta.json"))
    zone_centers = np.array([[z["lat"], z["lng"]] for z in meta["zone_centers"]])
    zz_dur = np.load(routing_dir / "osrm_zone_zone_duration_sec.npy")
    zc_dur = np.load(routing_dir / "osrm_zone_call_duration_sec.npy")
    zc_dist = np.load(routing_dir / "osrm_zone_call_distance_m.npy")
    return zone_centers, zz_dur, zc_dur, zc_dist


def histogram(resp: np.ndarray):
    bins = np.arange(0, HIST_MAX_MIN + 1, 1.0)
    counts, _ = np.histogram(np.clip(resp, 0, HIST_MAX_MIN), bins=bins)
    return [int(c) for c in counts]


def cumulative_series(static_resp: np.ndarray, dynamic_resp: np.ndarray):
    n = len(static_resp)
    idx = np.unique(np.linspace(0, n - 1, min(CUMULATIVE_POINTS, n)).astype(int))
    cs = np.cumsum(static_resp) / np.arange(1, n + 1)
    cd = np.cumsum(dynamic_resp) / np.arange(1, n + 1)
    saved = np.cumsum(static_resp - dynamic_resp)
    return {
        "call_index": [int(i + 1) for i in idx],
        "static_avg_min": [round(float(cs[i]), 3) for i in idx],
        "dynamic_avg_min": [round(float(cd[i]), 3) for i in idx],
        "cumulative_minutes_saved": [round(float(saved[i]), 1) for i in idx],
    }


def osrm_speed_calibration(zone_centers, zc_dur, zc_dist, calls):
    """Effective straight-line speed implied by REAL OSRM legs.

    The browser-side engine (any-city CAD upload) has no OSRM matrix, so it
    estimates travel time from great-circle distance. This measures the
    conversion factor on real road routes so that estimate is calibrated to
    observed data rather than a guessed mph number.
    """
    lat = calls["latitude"].to_numpy()
    lng = calls["longitude"].to_numpy()
    hav = sd.haversine_miles(zone_centers[:, 0][:, None], zone_centers[:, 1][:, None],
                             lat[None, :], lng[None, :])
    ok = (zc_dur > 30) & (hav > 0.25)
    straight_mph = hav[ok] / (zc_dur[ok] / 3600.0)
    detour = (zc_dist[ok] / 1609.34) / hav[ok]
    return {
        "n_real_legs": int(ok.sum()),
        "median_effective_straight_line_mph": round(float(np.median(straight_mph)), 2),
        "median_road_detour_factor": round(float(np.median(detour)), 3),
    }


def build_city(city_id: str, cfg: dict) -> dict:
    print(f"\n=== {cfg['name']} ===")
    sd.N_AMBULANCES = cfg["n_ambulances"]
    sd.K_ZONES = cfg["k_zones"]

    calls = cfg["calls"]()
    zone_centers, zz_dur, zc_dur, zc_dist = load_routing(cfg["routing_dir"])
    assert zc_dur.shape[1] == len(calls), (
        f"{city_id}: routing matrix has {zc_dur.shape[1]} calls, call stream has {len(calls)}")
    print(f"{len(calls):,} real calls, {len(zone_centers)} candidate posts, "
          f"{cfg['n_ambulances']} units")

    zone_ids = np.array([sd.nearest_zone(r.latitude, r.longitude, zone_centers)
                         for r in calls.itertuples(index=False)])
    zone_counts = np.bincount(zone_ids, minlength=len(zone_centers))
    zone_weights = zone_counts / zone_counts.sum()

    sim_minutes = sd.SIM_DAYS * 24 * 60
    q = min(0.95, (len(calls) * sd.SERVICE_MEAN_MIN) / (cfg["n_ambulances"] * sim_minutes))

    table = sd.mexclp_compliance_table(zone_weights, q, zz_dur,
                                       sd.RESPONSE_STANDARD_MIN * 60, len(zone_centers))
    home_zone_ids = [table[i % len(table)] for i in range(cfg["n_ambulances"])]

    static_resp, static_wait, static_events = sd.run_simulation(
        calls, zone_centers, zz_dur, zc_dur, table, "static", home_zone_ids,
        np.random.default_rng(RNG_SEED), log_events=True)
    dynamic_resp, dynamic_wait, dynamic_events = sd.run_simulation(
        calls, zone_centers, zz_dur, zc_dur, table, "dynamic", home_zone_ids,
        np.random.default_rng(RNG_SEED), log_events=True)

    idx = np.random.default_rng(RNG_SEED).choice(
        len(static_resp), size=min(5000, len(static_resp)), replace=False)
    _, p_value = wilcoxon(static_resp[idx], dynamic_resp[idx])

    summary = {
        "city": cfg["name"],
        "sim_days": sd.SIM_DAYS,
        "n_calls": int(len(calls)),
        "n_ambulances": cfg["n_ambulances"],
        "k_zones": len(zone_centers),
        "busy_fraction_q": round(float(q), 3),
        "response_standard_min": sd.RESPONSE_STANDARD_MIN,
        "service_time_assumption_min": sd.SERVICE_MEAN_MIN,
        "window_start": str(calls["datetime"].min()),
        "window_end": str(calls["datetime"].max()),
        "avg_response_min_static": round(float(static_resp.mean()), 2),
        "avg_response_min_dynamic": round(float(dynamic_resp.mean()), 2),
        "median_response_min_static": round(float(np.median(static_resp)), 2),
        "median_response_min_dynamic": round(float(np.median(dynamic_resp)), 2),
        "p90_response_min_static": round(float(np.percentile(static_resp, 90)), 2),
        "p90_response_min_dynamic": round(float(np.percentile(dynamic_resp, 90)), 2),
        "minutes_saved_avg": round(float(static_resp.mean() - dynamic_resp.mean()), 2),
        "minutes_saved_total": round(float((static_resp - dynamic_resp).sum()), 1),
        "pct_improvement": round(float((static_resp.mean() - dynamic_resp.mean())
                                       / static_resp.mean() * 100), 1),
        "pct_calls_improved": round(float((dynamic_resp < static_resp).mean() * 100), 1),
        "pct_calls_delayed_static": round(float((static_wait > 0).mean() * 100), 1),
        "pct_calls_delayed_dynamic": round(float((dynamic_wait > 0).mean() * 100), 1),
        "pct_within_standard_static": round(float((static_resp <= sd.RESPONSE_STANDARD_MIN).mean() * 100), 1),
        "pct_within_standard_dynamic": round(float((dynamic_resp <= sd.RESPONSE_STANDARD_MIN).mean() * 100), 1),
        "wilcoxon_p_value": float(p_value),
        "statistically_significant": bool(p_value < 0.05),
        "routing_source": "OSRM public demo server, real driving durations (no flat-mph assumption)",
    }

    if cfg["has_measured_response"]:
        prior = json.load(open(cfg["expect"]))
        for k in ("REAL_measured_response_min_median", "REAL_measured_response_min_p90",
                  "REAL_measured_n", "REAL_vs_SIM_note"):
            summary[k] = prior[k]

    # Assert we reproduced the already-published per-city numbers exactly.
    expected = json.load(open(cfg["expect"]))
    for key in ("avg_response_min_static", "avg_response_min_dynamic", "pct_improvement",
                "median_response_min_static", "median_response_min_dynamic"):
        if key in expected:
            assert abs(expected[key] - summary[key]) < 0.02, (
                f"{city_id}: {key} drifted -- committed {expected[key]}, recomputed {summary[key]}")
    print(f"reproduced committed numbers OK  |  static {summary['avg_response_min_static']} -> "
          f"dynamic {summary['avg_response_min_dynamic']} min ({summary['pct_improvement']}%)")

    addresses = {}
    if cfg["addresses"].exists():
        for a in json.load(open(cfg["addresses"])):
            addresses[int(a["zone_id"])] = {"street": a.get("street"),
                                            "neighborhood": a.get("neighborhood"),
                                            "display_name": a.get("display_name")}

    day_counts = calls["datetime"].dt.floor("D").value_counts()
    busiest_day = day_counts.idxmax()
    day_idx = np.where((calls["datetime"].dt.floor("D") == busiest_day).values)[0]

    bundle = {
        "id": city_id,
        "name": cfg["name"],
        "short": cfg["short"],
        "blurb": cfg["blurb"],
        "source_url": cfg["source_url"],
        "center": [float(np.median(calls["latitude"])), float(np.median(calls["longitude"]))],
        "summary": summary,
        "compliance_table": [int(z) for z in table],
        "zones": [{"lat": float(z[0]), "lng": float(z[1]), "weight": float(w), "calls": int(c)}
                  for z, w, c in zip(zone_centers, zone_weights, zone_counts)],
        "home_bases": [
            dict({"lat": float(zone_centers[z][0]), "lng": float(zone_centers[z][1]),
                  "zone_id": int(z), "rank": i + 1}, **(addresses.get(int(z)) or {}))
            for i, z in enumerate(home_zone_ids)
        ],
        "hist": {
            "bin_width_min": 1,
            "max_min": HIST_MAX_MIN,
            "static": histogram(static_resp),
            "dynamic": histogram(dynamic_resp),
        },
        "cumulative": cumulative_series(static_resp, dynamic_resp),
        "calibration": osrm_speed_calibration(zone_centers, zc_dur, zc_dist, calls),
        "race": {
            "date": str(busiest_day.date()),
            "n_calls": int(len(day_idx)),
            "n_ambulances": cfg["n_ambulances"],
            "static_events": [static_events[i] for i in day_idx],
            "dynamic_events": [dynamic_events[i] for i in day_idx],
        },
    }
    print(f"race day {bundle['race']['date']} ({bundle['race']['n_calls']} calls) | "
          f"calibration {bundle['calibration']}")
    return bundle


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    index = []
    for city_id, cfg in CITIES.items():
        bundle = build_city(city_id, cfg)
        path = OUT_DIR / f"{city_id}.json"
        with open(path, "w") as f:
            json.dump(bundle, f, separators=(",", ":"))
        size_kb = path.stat().st_size / 1024
        print(f"wrote {path.relative_to(ROOT)} ({size_kb:.0f} KB)")
        index.append({
            "id": city_id,
            "name": bundle["name"],
            "short": bundle["short"],
            "blurb": bundle["blurb"],
            "n_calls": bundle["summary"]["n_calls"],
            "pct_improvement": bundle["summary"]["pct_improvement"],
        })

    with open(OUT_DIR / "index.json", "w") as f:
        json.dump({"cities": index}, f, indent=2)
    print(f"\nwrote {(OUT_DIR / 'index.json').relative_to(ROOT)} with {len(index)} cities")


if __name__ == "__main__":
    main()
