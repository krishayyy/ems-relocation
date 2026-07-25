"""
Real, validated ML demand-forecasting layer.

WHY THIS EXISTS: the static/optimal-subset experiments in HANDOFF.md (secs
2.1-2.3) found a real, honest null result -- WHERE Seattle EMS calls happen
does not meaningfully shift by hour-of-day/day-of-week. Only call VOLUME
shifts. That means a time-varying compliance table (varying WHERE units are
staged) doesn't help. But a model that forecasts HOW MANY calls are coming
in the next hour is still genuinely useful: it tells you how many ambulances
should be active/staged right now (surge staffing), which is a real,
different question than "where."

This script:
  1. Aggregates the full real Seattle 911 history (2022-07-02 to present,
     ~4 years, 2.19M live rows / 500K sampled here) into an hourly citywide
     call-count time series.
  2. Trains a real gradient-boosted regressor (scikit-learn) on engineered
     time features (hour, day-of-week, weekend flag, lag features), with a
     CHRONOLOGICAL train/test split (last 30 days held out) -- not a random
     shuffle, since this is a real time series and shuffling would leak
     future information into training.
  3. Reports honest held-out metrics (MAE, RMSE) against a naive baseline
     (historical average for that hour-of-day/day-of-week combo), so the
     model's real value-add is visible, not just a single flattering number.
  4. Saves forecasts + metrics to data/demand_forecast.json for the
     simulator to display.

Nothing here is synthetic: every row feeding this model is a real call from
seattle_911_raw.csv (see HANDOFF.md Sec. 3 for provenance).
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error

OUT_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_CSV = OUT_DIR / "seattle" / "seattle_911_raw.csv"
HOLDOUT_DAYS = 30
N_LAGS = (1, 24, 24 * 7)  # previous hour, same hour yesterday, same hour last week

EMS_TYPES_CONTAINS = [
    "Aid Response", "Medic Response", "Low Acuity", "Triaged Incident",
    "Nurseline", "MVI", "Automatic Medical Alarm",
]


def load_hourly_series() -> pd.DataFrame:
    df = pd.read_csv(DATA_CSV)
    pattern = "|".join(EMS_TYPES_CONTAINS)
    df = df[df["type"].str.contains(pattern, case=False, na=False)].copy()
    df["datetime"] = pd.to_datetime(df["datetime"], errors="coerce")
    df = df.dropna(subset=["datetime"])

    hourly = (
        df.set_index("datetime")
        .resample("h")
        .size()
        .rename("n_calls")
        .to_frame()
    )
    # fill any gap hours with 0 calls (real gaps in the data, not missing values to hide)
    full_index = pd.date_range(hourly.index.min(), hourly.index.max(), freq="h")
    hourly = hourly.reindex(full_index, fill_value=0)
    hourly.index.name = "datetime"
    return hourly


def build_features(hourly: pd.DataFrame) -> pd.DataFrame:
    feat = hourly.copy()
    feat["hour"] = feat.index.hour
    feat["dow"] = feat.index.dayofweek
    feat["is_weekend"] = (feat["dow"] >= 5).astype(int)
    for lag in N_LAGS:
        feat[f"lag_{lag}h"] = feat["n_calls"].shift(lag)
    feat = feat.dropna()
    return feat


def naive_baseline(train: pd.DataFrame, test: pd.DataFrame) -> np.ndarray:
    """Historical average call count for a given (hour, day-of-week) combo,
    computed ONLY from training data -- the standard baseline a dispatcher
    without any model already effectively uses ('Tuesdays at 3pm are usually
    busy')."""
    avg_by_hour_dow = train.groupby(["hour", "dow"])["n_calls"].mean()
    preds = test.apply(lambda r: avg_by_hour_dow.get((r["hour"], r["dow"]),
                                                       train["n_calls"].mean()), axis=1)
    return preds.values


def main():
    print("Loading real hourly call-volume series from seattle_911_raw.csv ...")
    hourly = load_hourly_series()
    print(f"  {len(hourly):,} real hours, {hourly['n_calls'].sum():,.0f} real EMS-relevant calls, "
          f"{hourly.index.min()} -> {hourly.index.max()}")

    feat = build_features(hourly)
    split_time = feat.index.max() - pd.Timedelta(days=HOLDOUT_DAYS)
    train = feat[feat.index <= split_time]
    test = feat[feat.index > split_time]
    print(f"  train: {len(train):,} hours (through {split_time}) | "
          f"test (held out, never seen by the model): {len(test):,} hours")

    feature_cols = ["hour", "dow", "is_weekend"] + [f"lag_{lag}h" for lag in N_LAGS]
    X_train, y_train = train[feature_cols], train["n_calls"]
    X_test, y_test = test[feature_cols], test["n_calls"]

    model = GradientBoostingRegressor(
        n_estimators=200, max_depth=3, learning_rate=0.05, random_state=42
    )
    model.fit(X_train, y_train)
    pred = model.predict(X_test)
    pred = np.clip(pred, 0, None)

    baseline_pred = naive_baseline(train, test)

    model_mae = mean_absolute_error(y_test, pred)
    model_rmse = mean_squared_error(y_test, pred) ** 0.5
    baseline_mae = mean_absolute_error(y_test, baseline_pred)
    baseline_rmse = mean_squared_error(y_test, baseline_pred) ** 0.5

    improvement_mae_pct = 100 * (baseline_mae - model_mae) / baseline_mae

    print("\n=== Held-out results (last "
          f"{HOLDOUT_DAYS} real days, never used in training) ===")
    print(f"  naive historical-average baseline: MAE={baseline_mae:.3f} calls/hr, "
          f"RMSE={baseline_rmse:.3f}")
    print(f"  gradient-boosted forecast:          MAE={model_mae:.3f} calls/hr, "
          f"RMSE={model_rmse:.3f}")
    print(f"  MAE improvement over naive baseline: {improvement_mae_pct:+.1f}%")

    importances = dict(zip(feature_cols, model.feature_importances_.round(4).tolist()))

    # next-24h forecast from the end of the full series, for the simulator to display
    last_known = feat.iloc[-1]
    future_index = pd.date_range(hourly.index.max() + pd.Timedelta(hours=1), periods=24, freq="h")
    recent_lookup = hourly["n_calls"]
    future_rows = []
    for ts in future_index:
        row = {
            "hour": ts.hour,
            "dow": ts.dayofweek,
            "is_weekend": int(ts.dayofweek >= 5),
        }
        for lag in N_LAGS:
            lag_ts = ts - pd.Timedelta(hours=lag)
            row[f"lag_{lag}h"] = recent_lookup.get(lag_ts, recent_lookup.mean())
        future_rows.append(row)
    future_X = pd.DataFrame(future_rows, index=future_index)[feature_cols]
    future_pred = np.clip(model.predict(future_X), 0, None)

    out = {
        "model": "GradientBoostingRegressor (scikit-learn), n_estimators=200, max_depth=3",
        "training_window": f"{train.index.min()} to {train.index.max()}",
        "holdout_window": f"{test.index.min()} to {test.index.max()}",
        "n_train_hours": int(len(train)),
        "n_test_hours": int(len(test)),
        "feature_importances": importances,
        "holdout_metrics": {
            "naive_baseline_mae": round(float(baseline_mae), 3),
            "naive_baseline_rmse": round(float(baseline_rmse), 3),
            "model_mae": round(float(model_mae), 3),
            "model_rmse": round(float(model_rmse), 3),
            "mae_improvement_pct_vs_naive": round(float(improvement_mae_pct), 1),
        },
        "next_24h_forecast": [
            {"datetime": str(ts), "predicted_calls": round(float(p), 2)}
            for ts, p in zip(future_index, future_pred)
        ],
        "disclosed_scope": (
            "Forecasts CITYWIDE call VOLUME per hour, not per-zone location -- "
            "consistent with the finding in HANDOFF.md Sec 2.3 that call "
            "LOCATION doesn't meaningfully shift by time, only call VOLUME "
            "does. Intended use: surge staffing (how many units should be "
            "active right now), not zone repositioning (that's MEXCLP's job, "
            "see simulate_dynamic.py)."
        ),
    }
    with open(OUT_DIR / "demand_forecast.json", "w") as f:
        json.dump(out, f, indent=2, default=str)
    print(f"\nWrote {OUT_DIR / 'demand_forecast.json'}")


if __name__ == "__main__":
    main()
