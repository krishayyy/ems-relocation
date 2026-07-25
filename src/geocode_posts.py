"""
Reverse-geocode a city's MEXCLP post coordinates into real street addresses via
OpenStreetMap Nominatim, so the simulator can name a staging post ("605 South
Main Street") instead of showing bare lat/lng.

Nothing here affects the model -- it is presentation only. Rate-limited to 1
request/sec per Nominatim's usage policy, and cached to disk so it runs once.

Run:  python3 src/geocode_posts.py cincinnati
"""
import json
import ssl
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import certifi

ROOT = Path(__file__).resolve().parent.parent
UA = "ems-relocation-hackathon/1.0 (reverse geocoding ~20 static post coordinates)"

TARGETS = {
    "cincinnati": (ROOT / "data" / "bundles" / "cincinnati.json",
                   ROOT / "data" / "cincinnati" / "home_addresses.json"),
    "seattle": (ROOT / "data" / "bundles" / "seattle.json",
                ROOT / "data" / "home_addresses.json"),
}


def reverse(lat, lng):
    q = urllib.parse.urlencode({"lat": lat, "lon": lng, "format": "json", "zoom": 18})
    req = urllib.request.Request(f"https://nominatim.openstreetmap.org/reverse?{q}",
                                 headers={"User-Agent": UA})
    ctx = ssl.create_default_context(cafile=certifi.where())
    with urllib.request.urlopen(req, timeout=20, context=ctx) as r:
        return json.load(r)


def main():
    city = sys.argv[1] if len(sys.argv) > 1 else "cincinnati"
    bundle_path, out_path = TARGETS[city]
    bundle = json.load(open(bundle_path))

    seen, posts = set(), []
    for h in bundle["home_bases"]:
        if h["zone_id"] in seen:
            continue
        seen.add(h["zone_id"])
        posts.append(h)

    existing = {}
    if out_path.exists():
        existing = {a["zone_id"]: a for a in json.load(open(out_path))}

    out = []
    for i, p in enumerate(posts):
        if p["zone_id"] in existing and existing[p["zone_id"]].get("street"):
            out.append(existing[p["zone_id"]])
            continue
        try:
            r = reverse(p["lat"], p["lng"])
            addr = r.get("address", {})
            street = " ".join(x for x in [addr.get("house_number"), addr.get("road")] if x)
            out.append({
                "lat": p["lat"], "lng": p["lng"], "zone_id": p["zone_id"],
                "display_name": r.get("display_name", ""),
                "street": street or addr.get("road") or addr.get("suburb") or "Staging post",
                "neighborhood": addr.get("neighbourhood") or addr.get("suburb")
                                 or addr.get("city_district") or addr.get("city") or "",
            })
            print(f"[{i+1}/{len(posts)}] zone {p['zone_id']}: {out[-1]['street']} "
                  f"({out[-1]['neighborhood']})")
        except Exception as e:
            print(f"[{i+1}/{len(posts)}] zone {p['zone_id']}: FAILED {e}")
            out.append({"lat": p["lat"], "lng": p["lng"], "zone_id": p["zone_id"],
                        "display_name": "", "street": "Staging post", "neighborhood": ""})
        time.sleep(1.1)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(out, f, indent=2)
    print(f"\nwrote {out_path.relative_to(ROOT)} ({len(out)} posts) -- "
          f"now re-run src/export_city_bundles.py to fold them into the bundle")


if __name__ == "__main__":
    main()
