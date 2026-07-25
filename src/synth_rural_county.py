"""
Generate a synthetic 60-day CAD/911 call export for a rural county, in the
same column format as data/cincinnati/calls_60d.csv, so it can be dropped
into the "Bring your CAD data" uploader to test the model on a low-density,
spread-out rural service area instead of a dense city.

This is SYNTHETIC data -- there is no real feed for a small rural county.
Calls are Poisson-distributed in time (higher at evening/weekend peaks,
lower overnight) and scattered across real town centers + rural backroads
in Adams County, Ohio (pop. ~28,000, ~584 sq mi, single county EMS/dispatch,
no city over ~4,000 -- a genuinely rural service area, unlike Cincinnati/
Seattle).

Output: data/adams_county/calls_60d.csv
"""
import csv
import random
from datetime import datetime, timedelta
from pathlib import Path

random.seed(42)

OUT = Path(__file__).resolve().parent.parent / "data" / "adams_county" / "calls_60d.csv"

# Real town/hamlet centers in Adams County, OH (approximate lat/lon), each
# weighted by rough population share -- calls cluster near where people live,
# with a long tail scattered along rural roads (handled by the jitter below).
TOWNS = [
    ("West Union",     38.7959, -83.5457, 0.28),  # county seat, ~3,300
    ("Manchester",     38.7017, -83.6046, 0.14),  # ~2,000, river town
    ("Peebles",        38.9459, -83.4085, 0.10),
    ("Seaman",          38.9310, -83.5754, 0.08),
    ("Winchester",      38.9418, -83.6479, 0.09),
    ("North Adams",     38.8481, -83.4599, 0.06),
    ("Rural / backroads", 38.85, -83.50, 0.25),   # dispersed farmland calls
]

# Rough county bounding box for the rural-scatter component
LAT_MIN, LAT_MAX = 38.62, 39.05
LON_MIN, LON_MAX = -83.75, -83.30

INCIDENT_TYPES = [
    "SICK - 26A8 PAIN",
    "SICK - 26C2 ABNORMAL BREATH",
    "SICK - 26D1 NOT ALERT",
    "SICK - 26A1",
    "FALL - 17B1",
    "FALL - 17B4",
    "FALL - 17A2",
    "LIFT - 17A4",
    "BREATH - 6D2",
    "CHESTPN - 10D4 CLAMMY",
    "CARDARR - 9E1 OBVIOUS DEATH",
    "PERDWN - 32D1 UNKNOWN",
    "PERDWN - 32B2 MEDICAL ALARM",
    "MVC - 29A1 INJURIES UNKNOWN",
    "MVC - 29B2 ENTRAPMENT",
    "SEIZ - 12D1 CONTINUOUS SEIZING",
    "STROKE - 28A1",
    "OD - 23B1 INEFFECTIVE BREATHING",
    "ABDOM - 1A1",
    "FAINT - 31D4 NOT ALERT",
    "HEMORR - 21A1",
    "BURN - 7B1",
    "ASSLTI - (C) =",
    "=EMS1 - ALS1 RESPONSE",
    "=EMS - (C)",
]

# Hour-of-day weights (0-23): quiet overnight, ramps through the day,
# evening peak -- typical rural EMS call pattern.
HOUR_WEIGHTS = [
    2, 1, 1, 1, 1, 2, 3, 4, 5, 6, 6, 7,
    7, 7, 7, 7, 8, 9, 9, 8, 7, 5, 4, 3,
]

DAYS = 60
CALLS_PER_DAY_MEAN = 5.2  # small rural county: a few calls a day, not hundreds
START = datetime(2026, 5, 24, 0, 0, 0)


def sample_hour():
    return random.choices(range(24), weights=HOUR_WEIGHTS, k=1)[0]


def sample_location():
    town = random.choices(TOWNS, weights=[t[3] for t in TOWNS], k=1)[0]
    name, lat, lon, _ = town
    if name == "Rural / backroads":
        lat = random.uniform(LAT_MIN, LAT_MAX)
        lon = random.uniform(LON_MIN, LON_MAX)
    else:
        # jitter within a couple miles of the town center, occasionally
        # further out onto surrounding farm roads
        spread = 0.12 if random.random() < 0.25 else 0.03
        lat += random.uniform(-spread, spread)
        lon += random.uniform(-spread, spread)
    lat = min(max(lat, LAT_MIN), LAT_MAX)
    lon = min(max(lon, LON_MIN), LON_MAX)
    return lat, lon


def poisson(lam):
    # simple Knuth sampler, no numpy dependency
    l = 2.718281828459045 ** (-lam)
    k, p = 0, 1.0
    while True:
        k += 1
        p *= random.random()
        if p <= l:
            return k - 1


def main():
    rows = []
    for day in range(DAYS):
        n_calls = poisson(CALLS_PER_DAY_MEAN)
        # weekend bump (Fri/Sat nights busier)
        day_date = START + timedelta(days=day)
        if day_date.weekday() in (4, 5):
            n_calls += poisson(1.3)
        for _ in range(n_calls):
            hour = sample_hour()
            minute = random.randint(0, 59)
            second = random.randint(0, 59)
            t = day_date.replace(hour=hour, minute=minute, second=second)
            lat, lon = sample_location()
            incident = random.choice(INCIDENT_TYPES)
            rows.append((lat, lon, t, incident))

    rows.sort(key=lambda r: r[2])

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["latitude", "longitude", "create_time_incident", "incident_type_id", "datetime"])
        for lat, lon, t, incident in rows:
            create_time = t.strftime("%Y-%m-%dT%H:%M:%S.000")
            dt = t.strftime("%Y-%m-%d %H:%M:%S")
            w.writerow([f"{lat:.7f}", f"{lon:.6f}", create_time, incident, dt])

    print(f"Wrote {OUT}  ({len(rows):,} rows over {DAYS} days, "
          f"{len(rows)/DAYS:.1f} calls/day avg)")


if __name__ == "__main__":
    main()
