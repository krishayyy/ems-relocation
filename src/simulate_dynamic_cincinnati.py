"""
Cincinnati version of simulate_dynamic.py -- identical MEXCLP + real OSRM
routing simulation, run against real Cincinnati Fire Dept CAD calls instead
of Seattle's 911 feed. See simulate_dynamic.py for full method documentation
(Daskin 1983 MEXCLP, static vs. dynamic compliance-table repositioning,
identical paired real call stream for both strategies).

PURPOSE OF THIS RUN: not just "does dynamic beat static here too" -- also a
REALISM CHECK. Cincinnati's CAD export has REAL measured response times
(create_time_incident -> arrival_time_primary_unit), which Seattle's dataset
does not. This script reports the real Cincinnati response-time distribution
alongside the simulated static/dynamic distributions, so you can see whether
the simulation's numbers are in a realistic ballpark for a real mid-size
city, not just internally consistent.
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import wilcoxon

OUT_DIR = Path(__file__).resolve().parent.parent / "data" / "cincinnati"
CALLS_CSV = OUT_DIR / "calls_60d.csv"
RAW_CAD_CSV = Path(__file__).resolve().parent.parent / "data" / "cincinnati" / "cincinnati_cad_raw.csv"
N_AMBULANCES = 26       # peak load ~18.3 Erlangs (22 calls/hr x 50min); CFD runs ~26 frontline medic units in reality
K_ZONES = 20
SIM_DAYS = 60
SERVICE_MEAN_MIN = 50    # same disclosed assumption as the Seattle model
RESPONSE_STANDARD_MIN = 8
RNG_SEED = 42


def haversine_miles(lat1, lng1, lat2, lng2):
    r = 3958.8
    lat1, lng1, lat2, lng2 = map(np.radians, [lat1, lng1, lat2, lng2])
    dlat, dlng = lat2 - lat1, lng2 - lng1
    a = np.sin(dlat / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlng / 2) ** 2
    return 2 * r * np.arcsin(np.sqrt(a))


def load_calls() -> pd.DataFrame:
    df = pd.read_csv(CALLS_CSV, parse_dates=["datetime"]).sort_values("datetime").reset_index(drop=True)
    return df


def load_real_response_times() -> pd.DataFrame:
    """Real measured response times for the SAME 60-day window, for the realism check."""
    raw = pd.read_csv(RAW_CAD_CSV, usecols=[
        "event_number", "create_time_incident", "arrival_time_primary_unit", "incident_type_id",
    ])
    calls = load_calls()
    window_start, window_end = calls["datetime"].min(), calls["datetime"].max()
    raw["create"] = pd.to_datetime(raw["create_time_incident"], errors="coerce")
    raw["arrival"] = pd.to_datetime(raw["arrival_time_primary_unit"], errors="coerce")
    raw = raw.dropna(subset=["create", "arrival"])
    raw = raw[(raw["create"] >= window_start) & (raw["create"] <= window_end)]
    pattern = "|".join([
        "EMS", "SICK", "FALL", "CHESTPN", "BREATH", "SEIZURE", "ABDOM", "PERDWN",
        "FAINT", "LIFT", "DOMINJ", "ASSLTI", "BLEED", "STROKE", "DIAB", "PREG",
        "CARDIAC", "UNCONSC", "OD", "POISON", "BURN", "STAB", "GSW", "MVA", "MVI",
    ])
    raw = raw[raw["incident_type_id"].str.contains(pattern, case=False, na=False)]
    raw["response_min"] = (raw["arrival"] - raw["create"]).dt.total_seconds() / 60
    raw = raw[(raw["response_min"] > 0) & (raw["response_min"] < 120)]
    return raw


def load_routing():
    meta = json.load(open(OUT_DIR / "osrm_routing_meta.json"))
    zone_centers = np.array([[z["lat"], z["lng"]] for z in meta["zone_centers"]])
    zz_dur = np.load(OUT_DIR / "osrm_zone_zone_duration_sec.npy")
    zc_dur = np.load(OUT_DIR / "osrm_zone_call_duration_sec.npy")
    return zone_centers, zz_dur, zc_dur


def mexclp_compliance_table(zone_weights, q, zz_dur_sec, standard_sec, n_ranks):
    n_zones = len(zone_weights)
    covers = zz_dur_sec <= standard_sec
    chosen = []
    coverage_count = np.zeros(n_zones)
    remaining = set(range(n_zones))
    for _ in range(min(n_ranks, n_zones)):
        best_site, best_gain = None, -np.inf
        for s in remaining:
            covered_nodes = covers[:, s]
            marginal = zone_weights[covered_nodes] * (q ** coverage_count[covered_nodes]) * (1 - q)
            gain = marginal.sum()
            if gain > best_gain:
                best_gain, best_site = gain, s
        chosen.append(best_site)
        coverage_count += covers[:, best_site]
        remaining.remove(best_site)
    return chosen


class Ambulance:
    __slots__ = ("id", "lat", "lng", "zone_id", "free_time", "home_zone_id")

    def __init__(self, id_, zone_id, lat, lng):
        self.id = id_
        self.zone_id = zone_id
        self.lat = lat
        self.lng = lng
        self.free_time = pd.Timestamp.min
        self.home_zone_id = zone_id


def nearest_zone(lat, lng, zone_centers):
    d = haversine_miles(lat, lng, zone_centers[:, 0], zone_centers[:, 1])
    return int(np.argmin(d))


def reposition_idle_dynamic(idle_ambulances, compliance_sites, zone_centers, zz_dur_sec):
    targets = compliance_sites[:len(idle_ambulances)]
    unassigned = list(idle_ambulances)
    for target_zone in targets:
        durs = []
        for a in unassigned:
            src_zone = a.zone_id if a.zone_id is not None else nearest_zone(a.lat, a.lng, zone_centers)
            durs.append(zz_dur_sec[src_zone][target_zone])
        nearest = unassigned.pop(int(np.argmin(durs)))
        nearest.zone_id = target_zone
        nearest.lat, nearest.lng = zone_centers[target_zone][0], zone_centers[target_zone][1]


def run_simulation(calls, zone_centers, zz_dur_sec, zc_dur_sec, compliance_table, strategy,
                    home_zone_ids, rng):
    ambulances = [
        Ambulance(i, home_zone_ids[i], zone_centers[home_zone_ids[i]][0], zone_centers[home_zone_ids[i]][1])
        for i in range(N_AMBULANCES)
    ]
    response_minutes = np.empty(len(calls))
    wait_minutes = np.empty(len(calls))

    for i, row in enumerate(calls.itertuples(index=False)):
        t = row.datetime
        idle = [a for a in ambulances if a.free_time <= t]

        if strategy == "static":
            for a in idle:
                a.zone_id = a.home_zone_id
                a.lat, a.lng = zone_centers[a.zone_id][0], zone_centers[a.zone_id][1]
        elif idle:
            reposition_idle_dynamic(idle, compliance_table, zone_centers, zz_dur_sec)

        if idle:
            # With N_AMBULANCES > K_ZONES, more idle units can arrive in one
            # reposition call than there are compliance-table posts, leaving
            # a few with zone_id still None -- fall back to nearest zone for
            # those, same treatment as the busy/queued case below.
            idle_zone_ids = [a.zone_id if a.zone_id is not None else nearest_zone(a.lat, a.lng, zone_centers)
                              for a in idle]
            durs = [zc_dur_sec[z][i] for z in idle_zone_ids]
            best = int(np.argmin(durs))
            chosen = idle[best]
            start_time = t
            wait_min = 0.0
            travel_min = durs[best] / 60.0
        else:
            chosen = min(ambulances, key=lambda a: a.free_time)
            start_time = chosen.free_time
            wait_min = (start_time - t).total_seconds() / 60.0
            src_zone = chosen.zone_id if chosen.zone_id is not None else nearest_zone(chosen.lat, chosen.lng, zone_centers)
            travel_min = zc_dur_sec[src_zone][i] / 60.0

        response_minutes[i] = wait_min + travel_min
        wait_minutes[i] = wait_min

        service_min = max(5.0, rng.lognormal(mean=np.log(SERVICE_MEAN_MIN), sigma=0.35))
        finish_time = start_time + pd.Timedelta(minutes=travel_min + service_min)
        chosen.free_time = finish_time
        chosen.lat, chosen.lng = row.latitude, row.longitude
        chosen.zone_id = None

    return response_minutes, wait_minutes


def main():
    calls = load_calls()
    print(f"Simulating {len(calls):,} real Cincinnati calls over {SIM_DAYS} days "
          f"({calls['datetime'].min()} to {calls['datetime'].max()})")

    zone_centers, zz_dur_sec, zc_dur_sec = load_routing()
    assert zc_dur_sec.shape[1] == len(calls)

    zone_ids_per_call = np.array([nearest_zone(r.latitude, r.longitude, zone_centers)
                                   for r in calls.itertuples(index=False)])
    zone_counts = np.bincount(zone_ids_per_call, minlength=K_ZONES)
    zone_weights = zone_counts / zone_counts.sum()

    sim_minutes = SIM_DAYS * 24 * 60
    q = (len(calls) * SERVICE_MEAN_MIN) / (N_AMBULANCES * sim_minutes)
    q = min(0.95, q)
    peak_hourly = calls.set_index("datetime").resample("1h").size().max()
    print(f"Peak hourly call volume: {peak_hourly}  |  Empirical busy fraction q = {q:.3f}")

    standard_sec = RESPONSE_STANDARD_MIN * 60
    compliance_table = mexclp_compliance_table(zone_weights, q, zz_dur_sec, standard_sec, K_ZONES)
    # N_AMBULANCES can exceed K_ZONES=20 candidate posts (Cincinnati's real fleet is
    # bigger than the zone count) -- cycle through the ranked table so top-ranked
    # zones get multiple co-located units, same as real practice of stacking >1 unit
    # at a busy station.
    home_zone_ids = [compliance_table[i % len(compliance_table)] for i in range(N_AMBULANCES)]

    rng_static = np.random.default_rng(RNG_SEED)
    rng_dynamic = np.random.default_rng(RNG_SEED)

    static_resp, static_wait = run_simulation(calls, zone_centers, zz_dur_sec, zc_dur_sec,
                                               compliance_table, "static", home_zone_ids, rng_static)
    dynamic_resp, dynamic_wait = run_simulation(calls, zone_centers, zz_dur_sec, zc_dur_sec,
                                                 compliance_table, "dynamic", home_zone_ids, rng_dynamic)

    rng = np.random.default_rng(42)
    idx = rng.choice(len(static_resp), size=min(5000, len(static_resp)), replace=False)
    stat, p_value = wilcoxon(static_resp[idx], dynamic_resp[idx])
    pct_improved = float((dynamic_resp < static_resp).mean() * 100)

    real = load_real_response_times()

    summary = {
        "city": "Cincinnati, OH",
        "sim_days": SIM_DAYS,
        "n_calls": len(calls),
        "n_ambulances": N_AMBULANCES,
        "busy_fraction_q": round(float(q), 3),
        "avg_response_min_static": round(float(static_resp.mean()), 2),
        "avg_response_min_dynamic": round(float(dynamic_resp.mean()), 2),
        "median_response_min_static": round(float(np.median(static_resp)), 2),
        "median_response_min_dynamic": round(float(np.median(dynamic_resp)), 2),
        "p90_response_min_static": round(float(np.percentile(static_resp, 90)), 2),
        "p90_response_min_dynamic": round(float(np.percentile(dynamic_resp, 90)), 2),
        "pct_improvement": round(float((static_resp.mean() - dynamic_resp.mean()) / static_resp.mean() * 100), 1),
        "pct_calls_improved": round(pct_improved, 1),
        "wilcoxon_p_value": float(p_value),
        "statistically_significant": bool(p_value < 0.05),
        "REAL_measured_response_min_median": round(float(real["response_min"].median()), 2),
        "REAL_measured_response_min_p90": round(float(real["response_min"].quantile(0.9)), 2),
        "REAL_measured_n": int(len(real)),
        "REAL_vs_SIM_note": "Real Cincinnati Fire Dept response times are for the ACTUAL fielded fleet/dispatch policy; simulated static/dynamic figures assume a hypothetical N_AMBULANCES-truck fleet at MEXCLP-chosen posts. This is a realism check (is the simulated distribution in a plausible range for a real mid-size city), NOT a real-vs-model causal comparison -- real fleet size/positions are unknown from this CAD export.",
    }

    with open(OUT_DIR / "dynamic_sim_cincinnati.json", "w") as f:
        json.dump(summary, f, indent=2)

    print("\n=== MEXCLP + REAL ROAD ROUTING SIMULATION (Cincinnati, real calls) ===")
    print(f"Static  avg: {static_resp.mean():.2f} min (median {np.median(static_resp):.2f}, p90 {np.percentile(static_resp,90):.2f})")
    print(f"Dynamic avg: {dynamic_resp.mean():.2f} min (median {np.median(dynamic_resp):.2f}, p90 {np.percentile(dynamic_resp,90):.2f})")
    print(f"Improvement: {summary['pct_improvement']}%  |  p-value: {p_value:.2e}  significant: {summary['statistically_significant']}")
    print(f"\n=== REALISM CHECK vs ACTUAL Cincinnati Fire Dept performance (n={len(real):,}) ===")
    print(f"REAL median: {summary['REAL_measured_response_min_median']} min  |  REAL p90: {summary['REAL_measured_response_min_p90']} min")
    print(f"(sim dynamic median {np.median(dynamic_resp):.2f} / p90 {np.percentile(dynamic_resp,90):.2f} -- compare, don't equate)")


if __name__ == "__main__":
    main()
