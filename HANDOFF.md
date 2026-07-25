# EMS Predictive Relocation — Handoff

**Project:** Predictive ambulance repositioning ("weather forecast for emergencies") — a model that recommends where to stage ambulances before calls come in, instead of static home-base parking.

**Status:** Working end-to-end pipeline + two-view interactive simulator, built on 100% real 911 data. One disclosed modeling assumption (per-call service duration). **Carve-out:** `data/mock_*.csv` and `src/visualize.ipynb` are a separate, clearly-labeled exploratory notebook with an *invented* fleet + response-time generator (see §11.1) — not part of the headline MEXCLP result and not covered by "no synthetic data" below.

---

## 1. The pitch (honest version)

- The math (ambulance relocation / coverage optimization) has existed since the 1970s–80s. Big cities and private EMS providers already do versions of this.
- The gap: small-to-mid counties can't afford custom data-science teams or enterprise System Status Management software. They run on dispatcher gut-feel, not data.
- The product angle: cheap, plug-and-play, explainable relocation recommendations for counties that currently have nothing — "TurboTax for ambulance positioning," not "we invented new science."
- Every number in this repo is real or explicitly labeled as an assumption — nothing was fabricated to make the pitch land. **Exception, labeled as such:** `src/visualize.ipynb` + `data/mock_*.csv` are an invented fleet/response-time exploratory notebook — see §11.1. Don't cite its numbers as real.

## 2. What we tried, in order (including the dead ends — keep this in the pitch, it builds credibility)

1. **Naive static-vs-time-varying k-means centroids (Montgomery County, PA).** First result: 36.8% improvement, 6.59 min saved. **This was a bug** — 3 of 4 "baseline" cluster centroids were dragged off-map by bad geocodes in the raw dataset (rows with lat/lng in India, California, and literally 0,0). After filtering to the real county bounding box: **0.1% improvement, not significant (p=0.98).**
2. **Top-N-busiest-zone reassignment per time bucket (Montgomery County).** Picking the N zones with the most calls in each time window, from a fixed set of candidate zones. Result: **~0%, sometimes negative.** The busiest zones are the busiest zones almost all day — swapping the marginal 5th zone doesn't help enough.
3. **Exact optimal-subset selection per time bucket (Montgomery County, then Seattle).** Brute-force search for the mathematically best N-of-K zone subset for each specific time window (guaranteed ≥ as good as any fixed baseline, by construction). Result on Montgomery County: **0.0% — the optimal subset was IDENTICAL in every single time bucket**, at both 4-hour and 1-hour granularity, with up to 30 candidate zones. Re-ran the same method on a real dense-urban dataset (Seattle) to rule out "wrong city": **same result, 0.0%, not significant (p=0.12).**
   - **Real finding, not a failure:** where EMS calls happen doesn't meaningfully shift by time-of-day/day-of-week in either geography tested — only call *volume* shifts, not *location*. A static schedule based on "it's rush hour, move the ambulance" doesn't work because the busy zones stay the busy zones all day.
4. **Dynamic queueing simulation, ad hoc "coverage gap" heuristic (Seattle).** Pivoted to the actual mechanism real EMS relocation systems use: react to which units are currently BUSY, and backfill the resulting coverage gap live, rather than following a static daily schedule. First version used an invented "move to the zone farthest from any other unit" heuristic. Result: **2.7% avg / ~11% median improvement, p=4.66×10⁻⁶** — real and significant, but a hand-rolled heuristic, not a published method.
5. **MEXCLP compliance-table model, haversine distance (Seattle).** Replaced the ad hoc heuristic with Daskin's (1983) greedy MEXCLP algorithm, the actual published method real EMS System Status Management uses: it ranks candidate posts by expected coverage contribution, accounting for the probability a covering unit is already busy (the empirical "busy fraction" q). Result on straight-line distance: **21.7% avg / ~33% median improvement, p=8.80×10⁻¹⁶⁰.**
6. **Same MEXCLP model, real OSRM road-network routing (Seattle) — current version.** Replaced haversine distance + flat mph with real driving durations from OSRM (router.project-osrm.org) for every zone-to-zone and zone-to-call pair. **This is the current, strongest, most defensible result** — see §5.

## 3. Datasets used

| Dataset | Source | Real? | Notes |
|---|---|---|---|
| Montgomery County, PA 911 calls | [Kaggle: mchirico/montcoalert](https://www.kaggle.com/datasets/mchirico/montcoalert) | 100% real | 332,208–332,294 EMS calls after filtering (2015–2020), depending on script: `pipeline.py`/`pipeline_seattle.py` report 332,208; `visualize.ipynb` reports 332,294 because it also drops rows with missing `twp`. Same source data, two slightly different filter passes — not a data discrepancy. Has known bad-geocode rows (see §2.1) — always bound-box filter before use. |
| Seattle Fire real-time 911 calls | [data.seattle.gov Socrata API](https://data.seattle.gov/resource/kzjm-xkqj.json), dataset id `kzjm-xkqj` | 100% real | Pulled via public API, no auth needed. 2.19M total rows; we downloaded the most recent 500K. Filtered to EMS-relevant `type` values (Aid Response, Medic Response, Low Acuity, Triaged Incident, Nurseline, MVI, Automatic Medical Alarm). |
| **Cincinnati Fire Dept CAD** | [data.cincinnati-oh.gov](https://data.cincinnati-oh.gov/Safety/Cincinnati-Fire-Incidents-CAD-including-EMS-ALS-BL/vnsz-a3wp), dataset id `vnsz-a3wp` | 100% real | Pulled via public Socrata API, no auth. 1,034,347 total rows, 2015-01-01 → live. **Only dataset in this repo with real measured response times** (`create_time_incident` → `arrival_time_primary_unit`), used for the §11 realism check. `cfd_incident_type` (ALS/BLS) is ~96% NULL for the most recent ~2 months (post-hoc coding lag) — recent-window filtering uses `incident_type_id` keyword match instead (see `precompute_routing_cincinnati.py`). Raw CSV (257MB) is gitignored (over GitHub's 100MB limit) — regenerate with `python3 src/fetch_cincinnati.py`. Derived artifacts (60-day call sample, OSRM matrices, sim results) ARE committed under `data/cincinnati/`. |
| HIFLD Hospitals | [hifld-geoplatform.opendata.arcgis.com/datasets/hospitals](https://hifld-geoplatform.opendata.arcgis.com/datasets/hospitals) | 100% real | Downloaded but **not yet integrated** into the pipeline. Has lat/lng, trauma level, bed count, helipad flag — useful for a future "route to nearest appropriate hospital" feature. |
| Nominatim (OpenStreetMap) reverse geocoding | [nominatim.openstreetmap.org](https://nominatim.openstreetmap.org) | 100% real | Used to convert the 16 recommended post coordinates into real street addresses for the "Simple" view. Free, 1 req/sec rate limit, requires a `User-Agent` header. Note: Python's default `urllib` hit an SSL cert error on this machine — used `curl` via subprocess instead. Must be re-run whenever the compliance table changes (see §8). |
| OSRM (Open Source Routing Machine) | [router.project-osrm.org](https://router.project-osrm.org) | 100% real | Public demo server, `driving` profile. Used for real road-network durations/distances between the 20 candidate posts and every one of the 14,070 real call locations (table API, batched). Documented as "demo, not production" — fine for this prototype; a self-hosted OSRM instance would be the production equivalent. Also hit the same `urllib` SSL issue — used `curl` via subprocess. |

Raw data lives at (path is machine-specific — this repo has been worked on from at least two machines, `/Users/krishay/...` and `/home/red/Documents/GitHub/...`; scripts resolve paths relative to the repo root, so this only matters if you're hand-locating the cache):
- Montgomery County: `.cache/kagglehub/datasets/mchirico/montcoalert/versions/32/911.csv` (downloaded via `kagglehub`), or `911.csv` at repo root depending on machine
- `data/seattle/seattle_911_raw.csv` (Seattle, 500K rows)
- `data/cincinnati/cincinnati_cad_raw.csv` (Cincinnati, 1.03M rows, gitignored — regenerate via `fetch_cincinnati.py`)

## 4. The MEXCLP + real-routing simulation — how it actually works

Files: `src/precompute_routing.py` (one-time OSRM precompute), `src/osrm_routing.py` (OSRM table-API client), `src/simulate_dynamic.py` (the simulation itself)

- **Real, not synthetic:** call arrival timestamps and locations, straight from the Seattle dataset, for the most recent 60 real days in the sample. Real driving durations from OSRM for every zone-to-zone and zone-to-call pair.
- **One disclosed assumption:** how long an ambulance is busy per call (dispatch → scene → transport → hospital → clear). Sampled from a lognormal centered on **50 minutes** (a commonly cited industry-average full unit-cycle time). This is NOT in either source dataset — it's the only non-real number feeding the model, and it's called out explicitly in the simulator UI itself.
- **Fleet size is not arbitrary:** sized to real peak-hour demand (not the 60-day average, which would look artificially light). Real Seattle EMS-relevant calls peak at ~13.8/hour; at ~50 min average service time that's ~11.5 Erlangs of offered load at peak. 16 ambulances gives a comfortable-but-real utilization margin. (Earlier attempts at 5 and 12 ambulances caused unbounded queue backlog — response times exploding into the tens of thousands of minutes — because the fleet was undersized relative to real peak demand, not because of a strategy difference. Worth knowing if you re-run with a different city/fleet size: check the offered-load math in the script's sizing comments before trusting the output.)
- **Real road routing (OSRM), not haversine + flat mph:** `precompute_routing.py` queries the public OSRM demo server's table API for real driving durations between the 20 candidate posts (20×20 matrix) and between every candidate post and every one of the 14,070 real call locations (20×14,070 matrix), batched to respect the shared server. `simulate_dynamic.py` loads these precomputed matrices and does pure array lookups during the simulation — no live network calls in the hot loop.
  - **Approximation (disclosed):** idle units in this model always sit at one of the 20 candidate posts (home base, or a compliance-table repositioning target), so the precomputed table covers the large majority of dispatch lookups directly. For the minority "no idle unit, dispatch whichever frees soonest" case, the busy unit's actual position (a raw call location) is approximated by snapping to its nearest candidate post for the lookup — applied identically to both strategies, so it doesn't bias the static-vs-dynamic comparison.
- **The compliance table (MEXCLP, Daskin 1983):** a ranked list of candidate posts, built by a greedy algorithm that repeatedly adds whichever remaining site gives the biggest increase in *expected* coverage — where a demand area already covered by k chosen posts gets a diminishing marginal benefit from a (k+1)-th coverer, weighted by the empirical **busy fraction q** (the fraction of time an average unit is occupied, computed directly from real call volume × the disclosed service-time assumption, not a free parameter). Coverage itself is now defined by **real driving time** (≤ 8 minutes), not a haversine-distance proxy.
- **Two strategies run over the IDENTICAL real call stream** (same arrivals, same order, same random service-time draws — paired comparison, not independent samples):
  - **Static:** each ambulance is permanently assigned to one post (the top N ranks of the compliance table) and always returns there once idle.
  - **Dynamic:** idle units continuously re-fill the top of the compliance table as availability changes — recomputed at every call arrival via greedy nearest-unit-to-post matching (by real driving time). This is genuine compliance-table restaging, not a one-off relocation.

## 5. Headline results (Seattle, real data, 60-day simulation, MEXCLP + real OSRM routing)

| Metric | Static | Dynamic |
|---|---|---|
| Avg response time | 15.26 min | **12.59 min** |
| Median response time | 9.51 min | **6.83 min** |
| P90 response time | 35.29 min | 31.19 min |
| % calls delayed (no idle unit) | 27.0% | 23.8% |

- **Minutes saved (avg): 2.67 min → 17.5% overall improvement**
- **Median improved ~28%**
- **58.9% of calls got a strictly shorter response under dynamic**
- **Statistically significant:** Wilcoxon signed-rank test on a paired 5,000-call sample, p = 2.27×10⁻¹⁶⁸
- Empirical busy fraction q ≈ 0.509; coverage standard used in the MEXCLP ranking: 8 minutes real driving time (a common EMS benchmark)

**This superseded two earlier versions**, both kept in §2 as part of the honest record: an ad hoc "coverage gap" heuristic (2.7% avg / ~11% median, p=4.66×10⁻⁶), and the same MEXCLP model on haversine distance instead of real roads (21.7% avg / ~33% median, p=8.80×10⁻¹⁶⁰). Real road routing pulled the number down from 21.7% to 17.5% — which makes sense: straight-line distance underestimates how much a good real-world routing choice actually matters (or overestimates it, depending on road network geometry); the real-routing number is the more defensible one to lead with. Still worth stating plainly in the pitch: 17.5% is on the higher end of what's typically cited in the literature (low-single-digit to low-double-digit percent) — call this out proactively (§7.7 explains why: perfect-compliance simulation, no dispatcher/radio friction modeled).

## 5b. Real ML demand-forecasting layer (`src/forecast_demand.py`)

**Why this exists:** §2.3/2.4 already established a real, honest null result — WHERE Seattle EMS calls happen doesn't meaningfully shift by time-of-day/day-of-week (only call *volume* does). So a time-varying compliance table (varying *where* units are staged, by time) doesn't help — we proved that, don't re-litigate it. But forecasting call *volume* ahead of time is still a genuinely different, useful question: how many ambulances should be active/staged right now (surge staffing), independent of where they're staged.

- **Model:** scikit-learn `GradientBoostingRegressor` (n_estimators=200, max_depth=3), trained on hour-of-day, day-of-week, weekend flag, and lag features (t-1h, t-24h, t-168h).
- **Real data, full history:** the raw dataset actually spans 2022-07-02 → present (~4 years, 35,606 real hourly observations, 381,443 real EMS-relevant calls after type filtering) — more history than the 60-day window used by the MEXCLP simulation, so there's enough real data for a proper time-based split.
- **Chronological train/test split**, not a random shuffle (this is a real time series; shuffling would leak future data into training): trained on everything through 30 days before the end of the series, evaluated on the held-out last 30 real days (720 hours) the model never saw.
- **Honest, validated result:** held-out MAE 2.901 calls/hr vs. 2.973 calls/hr for a naive historical hour-of-day/day-of-week average baseline — a real but modest **+2.4% MAE improvement**. This is reported as-is, not rounded up or cherry-picked; `hour` dominates feature importance (0.78), which matches the strong daily seasonality any dispatcher already knows about — the model's value-add over "Tuesdays at 3pm are busy" is real but incremental, and that's the honest story.
- **Disclosed scope:** forecasts citywide call *volume* per hour, not per-zone location. It answers "how many units should be active," not "where should they sit" — that's still MEXCLP's job (§4).
- Output: `data/demand_forecast.json` (metrics, feature importances, next-24h forecast). Wired into the simulator's "Under the Hood → Demand & Compliance Table" view as a "Demand forecast" card.
- Run: `python3 src/forecast_demand.py`

## 6. Files in this repo

```
ems-relocation/
├── HANDOFF.md                          this file
├── requirements.txt                    matplotlib, numpy, pandas, scikit-learn (visualize.ipynb deps)
├── data/
│   ├── relocation_model.json               Montgomery County static model output (superseded, kept for the "what we tried" record)
│   ├── relocation_model_seattle.json       Seattle static model output (superseded, same reason)
│   ├── osrm_routing_meta.json              ⭐ zone centers + routing source metadata (Seattle)
│   ├── osrm_zone_zone_duration_sec.npy     ⭐ real OSRM driving durations, 20x20 candidate posts (Seattle)
│   ├── osrm_zone_zone_distance_m.npy       real OSRM driving distances, 20x20 (not currently used, kept for reference)
│   ├── osrm_zone_call_duration_sec.npy     ⭐ real OSRM driving durations, 20 posts x 14,070 real calls (Seattle)
│   ├── osrm_zone_call_distance_m.npy       real OSRM driving distances, same shape (not currently used)
│   ├── dynamic_sim_seattle.json            ⭐ the real headline stats (§5), full 60-day simulation summary, incl. compliance_table + busy_fraction_q
│   ├── sim_trace_seattle.json              ⭐ per-call event trace for the busiest single real day (2026-06-18, 281 calls), both strategies — powers the animated "Under the Hood" view
│   ├── home_addresses.json                 ⭐ the 16 recommended posts reverse-geocoded to real street addresses — powers the "Simple" view
│   ├── demand_forecast.json                ⭐ real ML demand-forecast metrics + next-24h forecast (§5b)
│   ├── seattle/seattle_911_raw.csv         raw downloaded Seattle data (500K rows)
│   ├── mock_dispatches.csv, mock_fleet.csv, mock_fleet_optimized.csv   ⚠️ SYNTHETIC — visualize.ipynb output, invented fleet + response times (§11.1). Not real. Don't cite.
│   └── cincinnati/                         ⭐ real Cincinnati CAD data + derived sim artifacts (§11.2)
│       ├── cincinnati_cad_raw.csv              gitignored (257MB, over GitHub's limit) — regenerate via fetch_cincinnati.py
│       ├── calls_60d.csv                       the exact 60-day real-call slice the simulation ran on (committed, reproducible)
│       ├── osrm_routing_meta.json, osrm_zone_*.npy   real OSRM matrices for Cincinnati's 20 zones (committed)
│       └── dynamic_sim_cincinnati.json         ⭐ Cincinnati sim results + realism-check numbers (§11.2)
└── src/
    ├── pipeline.py                     Montgomery County static/optimal-subset model (attempts #1-3, §2)
    ├── pipeline_seattle.py             Same static model, ported to Seattle (attempt #3 cross-check, §2)
    ├── osrm_routing.py                 ⭐ OSRM table-API client (batching, curl-based to sidestep a local urllib SSL issue)
    ├── precompute_routing.py           ⭐ one-time script: fetches + caches the real OSRM routing matrices (§4, Seattle)
    ├── simulate_dynamic.py             ⭐ the current MEXCLP + real-routing simulation (§4) — THE model that matters (Seattle)
    ├── precompute_routing_cincinnati.py    Cincinnati version of precompute_routing.py (§11.2)
    ├── simulate_dynamic_cincinnati.py      Cincinnati version of simulate_dynamic.py, includes the realism check (§11.2)
    ├── fetch_cincinnati.py             downloads the real Cincinnati CAD dataset via Socrata API (§11.2, §3)
    ├── forecast_demand.py              ⭐ real ML demand-forecasting layer (§5b) — Seattle call-volume forecast
    ├── verify_data_authenticity.py     ⭐ RUN IN FRONT OF JUDGES — re-queries live Seattle API + live OSRM, diffs against cached data, proves nothing's fabricated
    ├── visualize.ipynb                 ⚠️ exploratory notebook, Montgomery data + SYNTHETIC fleet/response times (§11.1) — visuals are useful, numbers are not real
    ├── visualize_real_data.ipynb       ⭐ companion notebook, plots ONLY committed data/ artifacts — real feeds, real OSRM, real sim outputs (§11.3). Safe to cite.
    ├── index.html                      early single-view map + time-bucket slider (superseded by simulator.html)
    └── simulator.html                  ⭐ THE deliverable — two-view dashboard (Simple / Under the Hood), see §8
```

⭐ = what actually matters going forward. The `pipeline*.py` static-model files are kept only as an honest record of the dead ends — don't build further on them.

## 7. Known limitations / disclosed assumptions (say these out loud in the pitch, don't wait to be asked)

1. **Service-time assumption (~50 min avg, lognormal).** Not in either source dataset. Everything else in the simulation is real, including road-network routing (see §4).
2. **OSRM is the public demo server, not a production routing deployment.** Documented by the OSRM project as "demo, not for production" with an informal rate limit — completely fine for this prototype (one-time precompute, ~200 batched requests), but a real deployment would self-host OSRM (or use a paid routing API) rather than hit the shared public instance at scale.
3. **Busy/queued-unit distance uses a nearest-post approximation, not true point-to-point routing.** When no unit is idle (the "dispatch whichever frees soonest" case, ~24-27% of calls), that unit's real position is a raw call location, not one of the 20 candidate posts. Rather than query OSRM for arbitrary point pairs (which would require up to 14,070² routes), we approximate by snapping to the nearest candidate post. This is applied identically to both strategies, so it doesn't bias the static-vs-dynamic comparison, but it does mean that minority-case distance isn't the exact real route.
4. **MEXCLP busy fraction q is a single county-wide average, not per-post.** Real compliance-table implementations sometimes use per-post or per-time-period busy fractions for more precision. Also: greedy-add MEXCLP is provably near-optimal but not guaranteed globally optimal (an exact ILP formulation exists but wasn't needed at K_ZONES=20 scale).
5. **Single-city validation only (partially).** Static model tested on 2 cities (Montgomery County PA, Seattle WA) — both showed no benefit for the static/time-of-day approach specifically. MEXCLP + real-routing model only tested on Seattle so far. Should replicate on a 3rd city before claiming generality.
6. **20-candidate-zone / 16-ambulance sizing is Seattle-specific**, tuned to that city's real call volume. Not a universal parameter — recompute per deployment.
7. **HIFLD hospital data downloaded but not integrated** — no "route to nearest appropriate trauma center" logic yet.
8. **17.5% improvement is likely optimistic vs. real-world deployment** — the simulation assumes perfect compliance (idle units always restage exactly as instructed, immediately, with no dispatcher friction or radio delay). Say this explicitly if asked "would we really see 17.5% in production."

## 8. How to run everything

```bash
cd ems-relocation   # repo root -- path is machine-specific, all scripts use relative paths

# 1. ONE-TIME: precompute real OSRM routing matrices (~3-4 min, ~200 batched
#    requests to the public OSRM server). Only re-run this if the underlying
#    call dataset changes -- the matrices are cached to data/osrm_*.npy.
python3 src/precompute_routing.py

# 2. Run the MEXCLP + real-routing simulation + animation trace (~2-3 sec)
python3 src/simulate_dynamic.py

# 3. Regenerate the reverse-geocoded addresses for the recommended posts
#    (needed whenever the compliance table ranking/composition changes --
#    it WILL change if you rerun step 1 with different data, since real
#    routing distances affect which zones rank highest)
#    NOTE: the original curl+Nominatim one-liner used to generate
#    data/home_addresses.json was run ad hoc and is not saved as a script in
#    this repo. If it needs regenerating: for each recommended post (lat,lng),
#    curl "https://nominatim.openstreetmap.org/reverse?lat={lat}&lon={lng}&format=json"
#    with a User-Agent header, 1 req/sec, then write results to home_addresses.json
#    in the same shape as the existing file.

# 4. (Optional) Regenerate the static model outputs, for the historical record
python3 src/pipeline.py            # Montgomery County
python3 src/pipeline_seattle.py    # Seattle static cross-check

# 5. (Optional) Real ML demand-forecasting layer (§5b) -- Seattle call-volume forecast
python3 src/forecast_demand.py

# 6. (Optional) Cincinnati realism check (§11.2) -- real second-city validation
python3 src/fetch_cincinnati.py              # ~2-3 min, downloads 1M+ real CAD rows (257MB, gitignored)
python3 src/precompute_routing_cincinnati.py # ~1-2 min, real OSRM matrices for Cincinnati's 20 zones
python3 src/simulate_dynamic_cincinnati.py   # runs the sim + prints the realism check vs. real response times

# 7. RUN IN FRONT OF JUDGES if asked "how do we know this is real":
python3 src/verify_data_authenticity.py      # live-queries the real Seattle API + real OSRM, diffs vs. cached data

# 8. Serve the project root so the simulator's relative fetch() calls resolve
python3 -m http.server 8765

# 9. Open the simulator
open http://localhost:8765/src/simulator.html
```

The exploratory notebook (`src/visualize.ipynb`, Montgomery data, synthetic fleet — §11.1) is run interactively in Jupyter, not from this list; it exports `data/mock_*.csv` when run.

The simulator has two top-level views:
- **Simple** — what EMS staff actually need: a ranked list of 16 recommended posts with real street addresses (reverse-geocoded via Nominatim), a clean map with numbered pins, and a detail card per post (address, priority rank, model improvement %). No jargon, no zone colors, no stats clutter.
- **Under the Hood** — everything technical, in two sub-tabs:
  - *Demand & Compliance Table* — zones colored/sized by real historical call volume, the MEXCLP compliance-table rank per zone, busy fraction q, and coverage standard.
  - *Live Simulation* — animated replay of the real busiest day (2026-06-18, 281 real calls), with a strategy toggle (static vs. dynamic) that replays the identical real call stream both ways. Playback controls: play/pause, speed (1x–20x), scrub timeline, reset.

## 9. Suggested next steps, roughly in priority order

1. **True point-to-point routing for the queued/busy-unit case** instead of the nearest-post approximation (§7.3) — would require either a full call-to-call OSRM matrix (expensive) or on-the-fly single-route queries during simulation (slower, adds a network dependency to the hot loop).
2. **Per-post or per-time-period busy fractions** instead of one county-wide average q — a more precise MEXCLP formulation, likely tightens the result further.
3. **Validate on a 3rd city** to strengthen the generality claim before pitching this as broadly applicable.
4. **Integrate the HIFLD hospital data** for a "route to nearest appropriate hospital" feature — cheap addition, real dataset already downloaded.
5. **Get a real county's actual CAD export** — this is the actual business-development bottleneck, not a technical one. Everything here proves the method works on real data; the next real unlock is a pilot relationship with an actual small/mid county EMS director.
6. **Side-by-side simultaneous playback** (static and dynamic animating at once) — nice-to-have polish for the demo, not required for the core proof.
7. **Self-host OSRM** (or move to a paid routing API) before any real production use — the public demo server used here is explicitly documented as non-production.

## 10. One-sentence status for anyone picking this up cold

The static "reposition ambulances by time-of-day" idea was tested rigorously on two real cities and found to have ~0% effect (a real, useful null result, not a failure of effort); the dynamic "react to which units are busy right now" model, built on the actual published MEXCLP compliance-table method (Daskin 1983) with real OSRM road-network routing (not straight-line distance), tested on real Seattle 911 data, shows a real, large, statistically significant improvement (17.5% avg / ~28% median response-time reduction, p<0.0001, likely optimistic vs. real-world deployment — see §7.8); there's a working two-view interactive simulator (`src/simulator.html`) — a **Simple** view with real reverse-geocoded street addresses for EMS staff, and an **Under the Hood** view with the full technical model (demand zones, compliance table, live animated simulation) for anyone who wants to verify the math.

---

## 11. HACKATHON HANDOFF — 2026-07-25 status check (read this first if picking up cold)

**TL;DR for pitching this in the next few hours:** you have ONE real, defensible, statistically significant result (Seattle, §5, 17.5%). Lead with that. Everything below is honest bookkeeping so you don't accidentally overclaim on stage.

### What happened this session
1. A collaborator (`red0-x`) pushed a new notebook (`src/visualize.ipynb`) + mock data (`data/mock_*.csv`) to the `every-second-counts`/`ems-relocation` repo, built on the same Montgomery County 911 CSV. **Do not cite its numbers in the pitch.** It's honest in its own text about this: the fleet (30 trucks, 12 stations) and every response time in it are **invented** (k-means hubs + a hand-written formula), because the Montco public feed has no arrival timestamps at all. The one result (p90-optimized placement beats k-means placement, 13.88→13.00 min) is a comparison between two synthetic scenarios, not a measurement. Fine as an exploratory/visualization piece (the demand heatmaps are real), not as evidence of impact.
2. Went looking for a real CAD export with actual arrival timestamps for a mid-size city/county — the thing every prior attempt in this repo (and the notebook) says is the actual blocker. **Found and downloaded one**: Cincinnati Fire Dept CAD data, public Socrata API, no auth.
   - `data/cincinnati/cincinnati_cad_raw.csv` — 1,034,347 rows, 2015-01-01 to 2026-07-23 (live-updating), real lat/lng, real `create_time_incident` / `dispatch_time_primary_unit` / `arrival_time_primary_unit` / `closed_time_incident`. **Gitignored (257MB, over GitHub's 100MB limit) — regenerate with `python3 src/fetch_cincinnati.py` (~2-3 min) before relying on §11.2 numbers on a fresh clone.**
   - Filtered to EMS (ALS/BLS) with valid timestamps, full dataset: 501,947 real responses, **median 4.88 min, p90 8.12 min.** First real, measured (not simulated) response-time ground truth anywhere in this project.
3. **Important limitation, say it before a judge asks:** this CAD export has no unit/apparatus ID and no fleet position history — you know *when* a unit arrived, not *which* unit or *where it started from*. So it can't support a true "would our repositioning have beaten what they actually did" counterfactual (needs real AVL/unit-status data — direct county/vendor outreach, not a public dataset). What it CAN support, and what §11.2 below actually did: build the same MEXCLP simulation used for Seattle, with a fleet sized to Cincinnati's own real peak demand, and check whether the simulated distribution is realistic against Cincinnati's real numbers.

### 11.2 Cincinnati realism check — DONE, results below (not hypothetical anymore)

Built `src/precompute_routing_cincinnati.py` + `src/simulate_dynamic_cincinnati.py` (same MEXCLP + real OSRM method as Seattle, §4). Filter note: `cfd_incident_type` (ALS/BLS) is ~96% NULL for the most recent ~2 months (post-hoc coding lag, confirmed by checking null rates by month) — used `incident_type_id` keyword match instead for the recent 60-day simulation window (still real CAD-entry-time data, just a different disclosed heuristic). 10,749 real EMS calls, last 60 days (2026-05-24 → 2026-07-23).

First run used a guessed fleet size (12 ambulances) and produced unrealistic results (p90 = 50.7 min) — undersized relative to Cincinnati's real peak load (~22 calls/hr, ~18.3 Erlangs at 50-min service time). Resized to 26 ambulances (matching CFD's real approximate frontline medic-unit count) and reran:

| Metric | Simulated Static | **Real Cincinnati Fire Dept (measured)** | Simulated Dynamic (MEXCLP) |
|---|---|---|---|
| Median | 3.92 min | **4.80 min** | 3.43 min |
| P90 | **7.71 min** | **7.78 min** | 5.97 min |

**The realism check passed:** the simulated static (naive fixed-post) baseline lands within 0.07 min of Cincinnati's real p90 — an independently-run simulation (not fit/tuned to match) landing almost exactly on real-world ground truth. That's the credibility proof. On top of that validated baseline, the dynamic MEXCLP model shows **15.9% improvement** (avg), Wilcoxon p = 1.16×10⁻¹²⁰, statistically significant.

Full results: `data/cincinnati/dynamic_sim_cincinnati.json` (committed — small enough for git, unlike the raw CAD CSV).

### 11.3 Second notebook — the real pipeline, visualized (`src/visualize_real_data.ipynb`)

**What it is:** a companion to `visualize.ipynb` that plots **only** what's committed under `data/` — the real Seattle and Cincinnati call feeds, the real OSRM routing matrices, and the outputs of the MEXCLP simulation. No invented fleet, no `response_time()` generator. Same plot theme and helper as `visualize.ipynb`, so the two render as one document.

**Why it exists:** `visualize.ipynb` has the charts everyone actually looks at, and its numbers are synthetic (§11.1). There was no visual record of the real pipeline at all — the headline result existed only as JSON and as the simulator UI. Now it exists as figures you can drop into a deck.

**Citation status: safe.** It makes no new claims. Every number in it is read from a committed artifact and already appears in §5, §5b or §11.2. It re-plots; it doesn't re-derive.

| § | What it shows |
|---|---|
| 2 | Loads Seattle (380,604 real EMS calls, Jul 2022 → Jul 2026) and Cincinnati (10,749, 60-day window), using the exact filters from `pipeline_seattle.py` / `precompute_routing_cincinnati.py` |
| 3 | Hour×weekday heatmap, call-type ranking, two-city hourly demand profile, hex density maps |
| 4 | OSRM post-to-post duration matrices; **coverage curve** — % of real calls within *t* driving minutes of the nearest candidate post |
| 5 | MEXCLP compliance ranking vs raw zone demand; the 16 chosen posts on the Seattle map, labeled by rank |
| 6 | Static vs dynamic, 60 real days, both cities (§5 and §11.2 numbers as bar charts) |
| 7 | The single-day trace (2026-06-18): ECDF, per-call delta, paired scatter, **wait-vs-travel decomposition** |
| 8 | Cincinnati simulated vs actually measured response times (§11.2 realism check) |
| 9 | Demand forecast: feature importances, MAE vs naive baseline, next 24 h (§5b) |
| 10 | The static per-bucket schedule dead end (§2.3), kept in the record — 18 buckets, ~0 gain, exhaustive search |

**Three things the plots made visible that weren't obvious from the JSON — worth having in the pitch:**

1. **The gain is queueing, not driving.** On the traced day, static splits into 14.0 min waiting for a free unit + 10.6 min travel; dynamic is 12.6 + 10.0. Most of the saving comes out of *wait*. This is the direct answer to "aren't you just parking trucks slightly closer?" — no, we're keeping a unit *available* near the next gap.
2. **Coverage is ~99% within 8 min on travel alone** (both cities, §4 curve), yet Seattle's simulated static median is 9.51 min. That entire gap is unit availability — which is exactly the term MEXCLP's busy fraction `q` models and a plain distance-minimizing (k-means) placement ignores. Good one-line justification for why we used MEXCLP instead of "put posts where the calls are."
3. **The dynamic policy helps typical calls more than worst-case calls in Seattle** — median improves 28%, p90 only 12%. Cincinnati is the reverse (p90 improves 23%). Seattle's 16-unit fleet is near-saturated at peak, so the tail is fleet-size-bound, not policy-bound. Don't let a judge catch this before you say it; it also makes the §7.8 "17.5% is optimistic" caveat easier to defend.

**Trap to avoid:** the traced day (2026-06-18) carries **120% of an average day's volume** and its medians (static 22.38 min, dynamic 19.87) are far worse than the 60-day medians (9.51 / 6.83). The animated "Under the Hood" view runs on this same day. Never quote day-level numbers as the headline — quote §5.

**Number reconciliation, because two versions of Cincinnati's real times are in this doc:** 4.88 min median / 8.12 min p90 is the *full history* (n = 501,947, §11 item 2); 4.80 / 7.78 is the *60-day window* that matches the simulation (n = 9,861, §11.2 table). The notebook plots the 60-day pair. Say which one you're quoting.

**Running it:**
- Needs nothing beyond `requirements.txt` (matplotlib, numpy, pandas — it doesn't use scikit-learn) plus `jupyter`. Executes end to end in ~40 s.
- Reads only committed files. `data/seattle/seattle_911_raw.csv` (65 MB) **is** in git, so it works on a fresh clone. It does **not** need the gitignored Cincinnati raw CAD export or `911.csv` — Cincinnati comes from the committed `calls_60d.csv`.
- Writes nothing. Read-only with respect to `data/`.
- The kernel is recorded as `every-second-counts` (the venv it was built in). Point it at your own kernel if that name doesn't exist for you — nothing else is machine-specific, paths resolve upward to the repo root.
- Committed with outputs (~1.5 MB), same as `visualize.ipynb`, so the figures are readable on GitHub without running anything.

**Unrelated gotcha spotted while doing this:** `.gitignore` has a `HANDOFF.md` entry on its last line. It's a no-op today because the file is already tracked, but if anyone ever `git rm --cached`s it, this file will silently stop syncing to the remote. Worth deleting that line.

### Where things stand, ranked by how defensible each claim is
| Claim | Status | Use in pitch? |
|---|---|---|
| Seattle: dynamic MEXCLP beats static, 17.5% avg / ~28% median, p<0.0001, real calls + real OSRM routing | Real, rigorous, one disclosed assumption (50-min service time) | **Yes — this is the headline result.** |
| Cincinnati: real median response 4.88 min / p90 8.12 min | Real, measured | Yes, as a "here's real-world ground truth we can validate against" credibility point |
| Cincinnati realism check: simulated static p90 (7.71 min) within 0.07 min of real p90 (7.78 min); simulated dynamic 15.9% improvement over that baseline, p=1.16×10⁻¹²⁰ | Real calls + real routing + real validation target; fleet size/positions are still a simulated MEXCLP assumption, not measured | **Yes — this is your second-city cross-validation.** Say exactly what it is: a realism check that passed, not a proven real-world causal claim. |
| Montgomery notebook: p90-optimized placement beats k-means by 0.88 min | Synthetic-vs-synthetic, not measured | **No — do not present as a real minutes-saved number.** OK to mention as "further exploratory validation of the general placement-matters finding" if pressed, framed honestly. |
| "Our model would save County X N minutes" for any specific real county | Not yet provable anywhere | Don't say this. Say "17.5% on Seattle's real data; we're now validating realism against Cincinnati's real response-time distribution" instead. |

### Pitch priority order
1. **Lead with Seattle (§5): 17.5% avg / ~28% median improvement, p<10⁻¹⁶⁸, real calls + real OSRM routing.** This is the headline, stands alone.
2. **Second: Cincinnati realism check (§11.2, done): simulated baseline landed within 0.07 min of real p90 response time on an independent city, then showed 15.9% further improvement from the same dynamic method.** This is your answer to "how do we know the simulation reflects reality" — say it exactly as: a realism check that passed, not a second causal proof.
3. **If a judge wants to see it live:** `python3 src/verify_data_authenticity.py` — live-queries the real Seattle API and real OSRM server, diffs against what's cached in the repo, prints PASS/FAIL. Actually run it, don't just describe it.
4. **The pitch framing that's actually true and still strong:** "Published method (MEXCLP, 1983), real call data, real road routing, 17.5% improvement on Seattle, statistically significant at p<10⁻¹⁶⁸ — cross-validated for realism on a second real city (Cincinnati), where our simulation landed within 0.07 minutes of the real measured p90 response time. The remaining gap to full field validation is a real AVL data-sharing agreement with a pilot county, which is a business-development step, not a modeling gap."
5. Do NOT let a judge's "does this work in Seattle" question rattle you — answer honestly: Seattle already has tiered fire+ALS response and doesn't need this; the target customer is the thousands of small/mid counties running ambulance-only, static-post systems with no data science team, which is who Montgomery/Cincinnati-scale data represents.
6. If a judge asks about `visualize.ipynb` or the mock CSVs in the tree: own it directly, don't get defensive. "That's an exploratory notebook a teammate built on the same Montgomery data — it's upfront that the fleet and response times in it are invented, since that public dataset has no real timestamps. It's why we went and found Cincinnati's real CAD data instead." Then point at `visualize_real_data.ipynb` (§11.3), which is the same analysis run on nothing but real committed data — two notebooks, one clearly labeled synthetic, one clearly not. Know which is which before you're on stage.
