import json
import os
import math
import requests

import h3

import firebase_admin
from firebase_admin import credentials, firestore, storage

KEY_PATH = os.environ.get("NETGAUGE_KEY_PATH", "repos/netgauge_service_account_key.json")
cred = credentials.Certificate(KEY_PATH)
firebase_admin.initialize_app(cred)

db = firestore.client()

def _median(vals):
    vals = [v for v in (vals or []) if v is not None and not (isinstance(v, float) and math.isnan(v))]
    if not vals:
        return None
    vals.sort()
    n = len(vals)
    mid = n // 2
    if n % 2 == 1:
        return float(vals[mid])
    return float((vals[mid - 1] + vals[mid]) / 2.0)

def _to_float(v):
    if v is None:
        return None
    try:
        return float(v)
    except Exception:
        return None
    
def _iso(v):
    if v is None:
        return None
    if hasattr(v, "isoformat"):
        return v.isoformat()
    return v

#For calculating usability, persistence, variability, and resilience
'''
These QoC calculations are the same as those used in the Supabase repo for consistency,
but could be adjusted based on the specific requirements or characteristics of the NetGauge data.
'''
RTT_Threshold = 100.0 

TimeWindow = 60.0

def calculate_usability(stats: dict) -> float | None:
    loss = _to_float(stats.get("loss_pct"))
    ping = _to_float(stats.get("ping_ms"))

    if loss is not None:
        return round(max(0.0, min(100.0,100.0 - loss)), 2)
    
    if ping is not None:
        if ping <= RTT_Threshold:
            return 100.0
        else:
            return 0.0
    
    return None

def calculate_persistence(stats: dict) -> float | None:

    ping = _to_float(stats.get("ping_ms"))
    if ping is None:
        return None
    
    headroom = (RTT_Threshold - ping) / RTT_Threshold * 100.0
    headroom = max(0.0, min(100.0, headroom))

    return round(headroom / 100.0 * TimeWindow, 2)

def calculate_variability(stats: dict) -> float | None:
    
    ping = _to_float(stats.get("ping_ms"))
    jitter = _to_float(stats.get("jitter_ms"))

    if ping is None or ping == 0 or jitter is None:
        return None 

    variability_pct = (jitter/ping) * 100.0

    return round((variability_pct/ 100.0) * TimeWindow, 2)

def calculate_resilience(stats: dict) -> float | None:
    
    recovery_threshold = 24.0

    loss = _to_float(stats.get("loss_pct"))
    if loss is None:
        return None
    
    outage_value = max(0.0, min(1.0, loss / 100.0))

    return round(outage_value * recovery_threshold, 2)

class NetGaugeRepo:

    def __init__(self, base: str, dash_secret: str | None = None):
        self.base = base
        self._dash = dash_secret
        self.http = requests.Session()

    def _rpc(self, fn: str, payload: dict):
        headers = {}
        if self._dash:
            headers["x-dashboard-secret"] = self._dash

        r = self.http.post(f"{self.base}/{fn}", json=payload, headers=headers, timeout=90)
        if r.status_code >= 400:
            raise RuntimeError(f"RPC {fn} failed ({r.status_code}): {r.text}")
        if not r.text:
            return None
        return r.json()
    
    def _rpc_map_points(self, bbox, filters: dict, limit: int):
        min_lng, min_lat, max_lng, max_lat = bbox
        payload = {
            "min_lng": float(min_lng),
            "min_lat": float(min_lat),
            "max_lng": float(max_lng),
            "max_lat": float(max_lat),
            "t_from": _iso(filters.get("from")),
            "t_to": _iso(filters.get("to")),
            "providers": filters.get("providers") or [],
            "conn": filters.get("conn") or [],
            "dl_min": filters.get("dl_min"),
            "dl_max": filters.get("dl_max"),
            "ul_min": filters.get("ul_min"),
            "ul_max": filters.get("ul_max"),
            "lat_min": filters.get("lat_min"),
            "lat_max": filters.get("lat_max"),
            "lim": int(limit),
        }
        return self._rpc("rpc_map_points", payload) or []
    
    def get_points(self, bbox, filters: dict, limit: int = 2000):
        rows = self._rpc_map_points(bbox=bbox, filters=filters, limit=limit)

        out = []
        for r in rows:
            stats = r.get("stats") or {}
            
            stats["usability_p"] = calculate_usability(stats)
            stats["persistence_p"] = calculate_persistence(stats)
            stats["variability_p"] = calculate_variability(stats)
            stats["resilience_p"] = calculate_resilience(stats)
#Stat Collection
            out.append({
                "group_id": r.get("group_id"),
                "provider": r.get("provider"),
                "conn_tag": r.get("conn_tag"),
                "timestamp": _iso(r.get("timestamp")),
                "center": r.get("center"),
                #"stats": r.get("stats") or {},
                "stats" : stats,
            })
        return out
    
    def get_hexes(self, res: int, bbox, filters: dict):
        pts = self.get_points(bbox=bbox, filters=filters, limit=20000)

        buckets = {}
        for p in pts:
            center = p.get("center") or []
            if not isinstance(center, list) or len(center) != 2:
                continue
            lon = _to_float(center[0])
            lat = _to_float(center[1])
            if lon is None or lat is None:
                continue

            try:
                cell = h3.latlng_to_cell(float(lat), float(lon), int(res))
            except Exception:
                continue

            b = buckets.get(cell)
            if b is None:
                b = {
                    "h3": str(cell),
                    "n": 0,
                    "dl": [],
                    "ul": [],
                    "ping": [],
                    "jitter": [],
                    "loss": [],
                    "sum_lon": 0.0,
                    "sum_lat": 0.0,
                    "cnt_center": 0,
                }
                buckets[cell] = b

            stats = p.get("stats") or {}
            b["n"] += 1
            b["dl"].append(_to_float(stats.get("down_mbps")))
            b["ul"].append(_to_float(stats.get("up_mbps")))
            b["ping"].append(_to_float(stats.get("ping_ms")))
            b["jitter"].append(_to_float(stats.get("jitter_ms")))
            b["loss"].append(_to_float(stats.get("loss_pct")))
            b["sum_lon"] += float(lon)
            b["sum_lat"] += float(lat)
            b["cnt_center"] += 1

        out = []
        for _, b in buckets.items():
            center = None
            if b["cnt_center"] > 0:
                center = [b["sum_lon"] / b["cnt_center"], b["sum_lat"] / b["cnt_center"]]

            out.append({
                "h3": b["h3"],
                "n": int(b["n"]),
                "dl_p50_mbps": _median(b["dl"]),
                "ul_p50_mbps": _median(b["ul"]),
                "ping_p50_ms": _median(b["ping"]),
                "jitter_p50_ms": _median(b["jitter"]),
                "loss_p50_pct": _median(b["loss"]),
                "center": center,
            })

        return out
    
    def get_groups_in_hex(self, h3_index: str, res: int, bbox, filters: dict, limit: int = 500):
        pts = self.get_points(bbox=bbox, filters=filters, limit=20000)

        matched = []
        for p in pts:
            center = p.get("center") or []
            if not isinstance(center, list) or len(center) != 2:
                continue
            lon = _to_float(center[0])
            lat = _to_float(center[1])
            if lon is None or lat is None:
                continue

            try:
                cell = h3.latlng_to_cell(float(lat), float(lon), int(res))
            except Exception:
                continue

            if str(cell) != str(h3_index):
                continue

            matched.append(p)

        matched.sort(key=lambda x: x.get("timestamp") or "", reverse=True)
        matched = matched[: int(limit)]

        out = []
        for p in matched:
            stats = p.get("stats") or {}
            out.append({
                "group_id": p.get("group_id"),
                "provider": p.get("provider"),
                "conn_tag": p.get("conn_tag"),
                "timestamp": _iso(p.get("timestamp")),
                "center": p.get("center"),
                "stats": {
                    "down_mbps": _to_float(stats.get("down_mbps")),
                    "up_mbps": _to_float(stats.get("up_mbps")),
                    "ping_ms": _to_float(stats.get("ping_ms")),
                    "jitter_ms": _to_float(stats.get("jitter_ms")),
                    "loss_pct": _to_float(stats.get("loss_pct")),
                    "usability_p": _to_float(stats.get("usability_p")),
                    "persistence_p": _to_float(stats.get("persistence_p")),
                    "variability_p": _to_float(stats.get("variability_p")),
                    "resilience_p": _to_float(stats.get("resilience_p")),
#Added stats to group details
                },
            })
        return out
    
    def get_group(self, group_id: str):
        return self._rpc("rpc_group_detail", {"group_id": str(group_id)})


