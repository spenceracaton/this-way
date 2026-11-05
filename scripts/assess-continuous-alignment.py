#!/usr/bin/env python3
"""Read-only same-road-name source geometry agreement diagnostic.

Compares retained Old Northeast and Crescent Lake source vertices to County road
centerlines. It does not fit or alter either neighborhood transform.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COUNTY = ROOT / "public/prototypes/continuous-map/data/context.geojson"
SOURCES = {
    "old-northeast": ROOT / "public/data/geography.json",
    "crescent-lake": ROOT / "public/data/crescent-lake/geography.json",
}
ALIGNMENT = ROOT / "public/prototypes/continuous-map/data/alignment.json"
RADIUS_M = 6_371_008.8
MERCATOR_M_PER_PIXEL_Z0 = 156543.03392804097

WORD_MAP = {
    "first": "1", "second": "2", "third": "3", "fourth": "4", "fifth": "5",
    "sixth": "6", "seventh": "7", "eighth": "8", "ninth": "9", "tenth": "10",
    "eleventh": "11", "twelfth": "12", "thirteenth": "13", "fourteenth": "14",
    "fifteenth": "15", "sixteenth": "16", "seventeenth": "17", "eighteenth": "18",
    "nineteenth": "19", "twentieth": "20", "twentyfirst": "21", "twentysecond": "22",
    "twentythird": "23", "twentyfourth": "24", "twentyfifth": "25", "twentysixth": "26",
    "twentyseventh": "27", "twentyeighth": "28", "twentyninth": "29", "thirtieth": "30",
    "north": "n", "south": "s", "east": "e", "west": "w",
    "northeast": "ne", "northwest": "nw", "southeast": "se", "southwest": "sw",
    "street": "st", "avenue": "ave", "boulevard": "blvd", "drive": "dr",
    "road": "rd", "court": "ct", "circle": "cir", "terrace": "ter",
    "place": "pl", "parkway": "pkwy", "lane": "ln", "highway": "hwy",
}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def normalize_name(value: str) -> str:
    value = value.lower().replace("&", " and ")
    value = re.sub(r"(?<=[a-z])-(?=[a-z])", "", value)
    value = re.sub(r"\b(\d+)(st|nd|rd|th)\b", r"\1", value)
    tokens = re.findall(r"[a-z]+|\d+", value)
    normalized = []
    i = 0
    while i < len(tokens):
        if i + 1 < len(tokens) and tokens[i] == "twenty" and tokens[i + 1] in WORD_MAP:
            second = WORD_MAP[tokens[i + 1]]
            if second.isdigit() and 1 <= int(second) <= 9:
                normalized.append(str(20 + int(second)))
                i += 2
                continue
        normalized.append(WORD_MAP.get(tokens[i], tokens[i]))
        i += 1
    return " ".join(normalized)


def valid_line(coords) -> list[tuple[float, float]]:
    points = []
    for item in coords or []:
        if isinstance(item, (list, tuple)) and len(item) >= 2:
            lon, lat = item[0], item[1]
            if isinstance(lon, (int, float)) and isinstance(lat, (int, float)):
                if math.isfinite(lon) and math.isfinite(lat) and -180 <= lon <= 180 and -90 <= lat <= 90:
                    points.append((float(lon), float(lat)))
    return points


def extract_county_lines(data: dict) -> dict[str, list[list[tuple[float, float]]]]:
    lines = defaultdict(list)
    for feature in data.get("features", []):
        props, geom = feature.get("properties") or {}, feature.get("geometry") or {}
        name = props.get("name")
        if props.get("kind") != "road" or not isinstance(name, str) or not name.strip():
            continue
        if geom.get("type") == "LineString":
            candidates = [geom.get("coordinates")]
        elif geom.get("type") == "MultiLineString":
            candidates = geom.get("coordinates") or []
        else:
            continue
        for candidate in candidates:
            points = valid_line(candidate)
            if len(points) >= 2:
                lines[normalize_name(name)].append(points)
    return lines


def extract_source_roads(map_id: str, data: dict) -> list[dict]:
    roads = []
    for feature in data.get("features", []):
        if map_id == "old-northeast":
            name = feature.get("name")
            coords = feature.get("coordinates_lat_lon") or []
            points = [(float(lon), float(lat)) for lat, lon in coords
                      if isinstance(lat, (int, float)) and isinstance(lon, (int, float))]
            kind = feature.get("kind")
        else:
            props, geom = feature.get("properties") or {}, feature.get("geometry") or {}
            name, kind = props.get("name"), props.get("highway")
            points = valid_line(geom.get("coordinates")) if geom.get("type") == "LineString" else []
            kind = "road" if kind else None
        if kind == "road" and isinstance(name, str) and name.strip() and len(points) >= 2:
            roads.append({"name": name, "key": normalize_name(name), "points": points})
    return roads


def vertex_to_segment_m(point: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
    """Local equirectangular metric projection centered at the source vertex."""
    lon0, lat0 = point
    cos_lat = math.cos(math.radians(lat0))

    def xy(p):
        return (math.radians(p[0] - lon0) * RADIUS_M * cos_lat,
                math.radians(p[1] - lat0) * RADIUS_M)

    ax, ay = xy(a)
    bx, by = xy(b)
    dx, dy = bx - ax, by - ay
    denom = dx * dx + dy * dy
    t = 0.0 if denom == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / denom))
    return math.hypot(ax + t * dx, ay + t * dy)


def nearest_m(point, lines) -> float:
    best = math.inf
    for line in lines:
        for a, b in zip(line, line[1:]):
            best = min(best, vertex_to_segment_m(point, a, b))
    return best


def percentile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * p
    low, high = math.floor(position), math.ceil(position)
    return ordered[low] if low == high else ordered[low] * (high - position) + ordered[high] * (position - low)


def main() -> None:
    county_data = json.loads(COUNTY.read_text())
    county_lines = extract_county_lines(county_data)
    min_lon, min_lat, max_lon, max_lat = county_data["bbox"]
    results = {}
    input_hashes = {"countyContext": {"path": str(COUNTY.relative_to(ROOT)), "sha256": sha256(COUNTY)}}
    for map_id, path in SOURCES.items():
        data = json.loads(path.read_text())
        source_roads = extract_source_roads(map_id, data)
        input_hashes[map_id] = {"path": str(path.relative_to(ROOT)), "sha256": sha256(path)}
        matched = [road for road in source_roads if road["key"] in county_lines]
        missing = [road for road in source_roads if road["key"] not in county_lines]
        point_residuals = [(point, nearest_m(point, county_lines[road["key"]]))
                           for road in matched for point in road["points"]]
        residuals = [distance for _, distance in point_residuals]
        covered_residuals = [distance for (lon, lat), distance in point_residuals
                             if min_lon <= lon <= max_lon and min_lat <= lat <= max_lat]
        outside_count = len(point_residuals) - len(covered_residuals)
        latitudes = [point[1] for road in matched for point in road["points"]]
        mean_lat = sum(latitudes) / len(latitudes) if latitudes else 0
        pixels_per_meter = {
            str(z): 1 / (MERCATOR_M_PER_PIXEL_Z0 * math.cos(math.radians(mean_lat)) / (2 ** z))
            for z in (15, 16, 17)
        }
        stats = {
            "median": percentile(residuals, 0.5),
            "p95": percentile(residuals, 0.95),
            "max": max(residuals) if residuals else None,
        }
        results[map_id] = {
            "sourceRoadFeatures": len(source_roads),
            "sameNormalizedNameRoadFeatures": len(matched),
            "missingCountyNameRoadFeatures": len(missing),
            "missingRoadNames": sorted({road["name"] for road in missing}),
            "sourceVerticesInMatchedRoads": len(residuals),
            "sourceVerticesWithinCountyContextBounds": len(covered_residuals),
            "sourceVerticesOutsideCountyContextBounds": outside_count,
            "distanceMeters": {key: round(value, 3) if value is not None else None for key, value in stats.items()},
            "withinContextBoundsDistanceMeters": {
                "median": round(percentile(covered_residuals, 0.5), 3) if covered_residuals else None,
                "p95": round(percentile(covered_residuals, 0.95), 3) if covered_residuals else None,
                "max": round(max(covered_residuals), 3) if covered_residuals else None,
            },
            "distanceCssPixelsByZoom": {
                z: {key: round(value * pixels_per_meter[z], 2) if value is not None else None
                    for key, value in stats.items()}
                for z in pixels_per_meter
            },
        }

    report = {
        "method": "All vertices from retained named source road features are measured to the nearest segment among County road features with exactly equal normalized full names. Distances use a local equirectangular metric approximation centered on each vertex.",
        "normalization": "Case/punctuation insensitive; numeric ordinal and spelled ordinal normalization; full direction and road-type words normalize to County abbreviations. No substring or partial-token matching.",
        "countyFeatures": len(county_data.get("features", [])),
        "countyNamedRoadKeys": len(county_lines),
        "inputs": input_hashes,
        "maps": results,
        "limitations": [
            "This is broad source-road agreement, not independent held-out intersection validation. The source coordinates and County lines are separate retained datasets, but this report does not validate the affine image transforms or fit/correct them.",
            "Name-matched lines may be only partial county coverage. Missing names and vertices beyond the County context bounds are not treated as accuracy failures or omitted from the reported missing-name counts.",
            "Every source vertex is weighted equally; distances are to nearest same-name County line segment, not necessarily the corresponding segment along a long or repeated street name.",
        ],
    }
    alignment = json.loads(ALIGNMENT.read_text())
    alignment["sourceRoadAgreement"] = report
    ALIGNMENT.write_text(json.dumps(alignment, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
