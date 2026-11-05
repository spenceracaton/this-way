#!/usr/bin/env python3
"""Build county context and lazy local-road tiles from retained public snapshots.

Evidence stays outside public/. --refresh-source reacquires current county GIS;
the default rebuild validates and reuses its retained, hashed source snapshots.
The tile grid is a loading mechanism, not a neighborhood or access boundary.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import datetime as dt
import hashlib
import json
import math
import pathlib
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
ATLAS = ROOT / "public/prototypes/pinellas-atlas/atlas-data.json"
LOCAL = ROOT / "public/prototypes/continuous-map/data/context.geojson"
EVIDENCE = ROOT.parent / "design-review/discovery-map/source"
OUT = ROOT / "public/prototypes/discovery-map/data"
ROAD_SERVICE = "https://services.arcgis.com/f5HgUpxURgEzTccH/ArcGIS/rest/services/Pinellas_RoadCenterline_view/FeatureServer/0"
BBOX = [-82.852168, 27.611854, -82.587625, 28.173319]
MAJOR_CLASSES = ("Interstate", "Expressway", "Freeway", "Ramp", "Highway", "Major Arterial", "Minor Arterial", "Collector", "Bridge")
GRID = 0.04


def compact(value):
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n").encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def simplify(points, tolerance):
    pts = [[round(float(p[0]), 6), round(float(p[1]), 6)] for p in points]
    if len(pts) < 3:
        return pts
    keep = {0, len(pts)-1}
    stack = [(0, len(pts)-1)]
    while stack:
        a, b = stack.pop()
        x1, y1 = pts[a]
        x2, y2 = pts[b]
        dx, dy = x2-x1, y2-y1
        den = dx*dx+dy*dy
        best, index = tolerance, None
        for i in range(a+1, b):
            x, y = pts[i]
            t = 0 if not den else max(0, min(1, ((x-x1)*dx+(y-y1)*dy)/den))
            distance = ((x-(x1+t*dx))**2+(y-(y1+t*dy))**2)**0.5
            if distance > best:
                best, index = distance, i
        if index is not None:
            keep.add(index)
            stack.extend(((a, index), (index, b)))
    return [point for i, point in enumerate(pts) if i in keep]


def request_json(url, params=None):
    data = None if params is None else urllib.parse.urlencode({**params, "f": "json"}).encode()
    headers = {"User-Agent": "this-way-discovery-map/1.0"}
    if data is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    request = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(request, timeout=90) as response:
        result = json.loads(response.read())
    if result.get("error"):
        raise RuntimeError(f"County GIS rejected request: {result['error'].get('message', 'unknown error')}")
    return result


def query(params):
    return request_json(ROAD_SERVICE + "/query", params)


def acquire(metadata, where, prefix, tolerance, refresh=False):
    snapshot = EVIDENCE / f"{prefix}-road-features.json"
    evidence_path = EVIDENCE / f"{prefix}-road-acquisition.json"
    if snapshot.exists() and evidence_path.exists() and not refresh:
        raw = snapshot.read_bytes()
        evidence = json.loads(evidence_path.read_text())
        if evidence.get("snapshotSha256") != sha(raw) or evidence.get("where") != where:
            raise RuntimeError(f"Retained {prefix} snapshot is inconsistent; use --refresh-source")
        return json.loads(raw), evidence
    spatial = {"where": where, "geometry": ",".join(map(str, BBOX)),
               "geometryType": "esriGeometryEnvelope", "spatialRel": "esriSpatialRelIntersects", "inSR": 4326}
    ids = query({**spatial, "returnIdsOnly": "true", "returnGeometry": "false"}).get("objectIds")
    if not isinstance(ids, list) or not ids or len(ids) != len(set(ids)):
        raise RuntimeError(f"County GIS returned invalid {prefix} road IDs")
    ids.sort()
    oid = metadata.get("objectIdField") or "OBJECTID"

    def page(page_ids):
        result = query({"objectIds": ",".join(map(str, page_ids)),
                        "outFields": f"{oid},FULLNAME,ROADCLASS,CENTERLINEID", "returnGeometry": "true",
                        "outSR": 4326, "maxAllowableOffset": tolerance, "geometryPrecision": 6})
        rows = result.get("features")
        if not isinstance(rows, list) or result.get("exceededTransferLimit"):
            raise RuntimeError(f"County GIS returned an incomplete {prefix} page")
        if {row.get("attributes", {}).get(oid) for row in rows} != set(page_ids):
            raise RuntimeError(f"County GIS changed {prefix} IDs during acquisition")
        return rows

    pages = [ids[start:start+500] for start in range(0, len(ids), 500)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = [row for batch in pool.map(page, pages) for row in batch]
    rows.sort(key=lambda row: row["attributes"][oid])
    raw = compact(rows)
    evidence = {"url": ROAD_SERVICE, "where": where, "extent": BBOX,
                "spatialRelation": "intersects", "outSR": 4326, "geometryPrecision": 6,
                "maxAllowableOffsetDegrees": tolerance, "featureCount": len(rows),
                "acquiredAt": dt.datetime.now(dt.timezone.utc).isoformat(), "snapshotSha256": sha(raw),
                "fields": [oid, "FULLNAME", "ROADCLASS", "CENTERLINEID"]}
    snapshot.write_bytes(raw)
    evidence_path.write_bytes(compact(evidence))
    print(f"Acquired {prefix}: {len(rows)} county road features", flush=True)
    return rows, evidence


def road_feature(row, oid, tier, tolerance):
    attributes = row["attributes"]
    paths = row.get("geometry", {}).get("paths", [])
    paths = [simplify(path, tolerance) for path in paths if len(path) >= 2]
    if not paths:
        raise RuntimeError(f"Road {attributes.get(oid)} has no usable path")
    geometry = {"type": "LineString", "coordinates": paths[0]} if len(paths) == 1 else {"type": "MultiLineString", "coordinates": paths}
    return {"type": "Feature", "geometry": geometry, "properties": {
        "kind": "road", "tier": tier, "name": str(attributes.get("FULLNAME") or ""),
        "class": str(attributes.get("ROADCLASS") or ""), "sourceId": f"pinellas-road:{attributes[oid]}"}}


def tile_features(features):
    buckets = {}
    for feature in features:
        geometry = feature["geometry"]
        paths = [geometry["coordinates"]] if geometry["type"] == "LineString" else geometry["coordinates"]
        xs = [point[0] for path in paths for point in path]
        ys = [point[1] for path in paths for point in path]
        left, right = max(BBOX[0], min(xs)), min(BBOX[2], max(xs))
        bottom, top = max(BBOX[1], min(ys)), min(BBOX[3], max(ys))
        if left > right or bottom > top:
            raise RuntimeError("A queried road does not intersect the requested envelope")
        for x in range(math.floor((left-BBOX[0])/GRID), math.floor((right-BBOX[0])/GRID)+1):
            for y in range(math.floor((bottom-BBOX[1])/GRID), math.floor((top-BBOX[1])/GRID)+1):
                buckets.setdefault((x, y), []).append(feature)
    entries = []
    for (x, y), rows in sorted(buckets.items()):
        west, south = round(BBOX[0]+x*GRID, 6), round(BBOX[1]+y*GRID, 6)
        east, north = round(min(west+GRID, BBOX[2]), 6), round(min(south+GRID, BBOX[3]), 6)
        name = f"context-local-{x}-{y}.geojson"
        data = compact({"type": "FeatureCollection", "bbox": [west, south, east, north], "features": rows})
        (OUT/name).write_bytes(data)
        entries.append({"id": f"{x}-{y}", "url": f"./data/{name}", "bounds": [[south, west], [north, east]],
                        "featureCount": len(rows), "bytes": len(data), "sha256": sha(data)})
    return entries


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh-source", action="store_true")
    args = parser.parse_args()
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    atlas_bytes, local_bytes = ATLAS.read_bytes(), LOCAL.read_bytes()
    atlas, local = json.loads(atlas_bytes), json.loads(local_bytes)
    metadata_path = EVIDENCE/"county-road-metadata.json"
    if metadata_path.exists() and not args.refresh_source:
        metadata_raw = metadata_path.read_bytes()
    else:
        metadata_raw = compact(request_json(ROAD_SERVICE+"?f=json"))
        metadata_path.write_bytes(metadata_raw)
    metadata = json.loads(metadata_raw)
    class_list = ",".join("'"+name+"'" for name in MAJOR_CLASSES)
    regional_rows, regional_evidence = acquire(metadata, f"ROADCLASS IN ({class_list})", "regional", 0.0001, args.refresh_source)
    local_rows, local_evidence = acquire(metadata, f"ROADCLASS NOT IN ({class_list}) OR ROADCLASS IS NULL", "local", 0.00003, args.refresh_source)
    oid = metadata.get("objectIdField") or "OBJECTID"
    regional_ids = {row["attributes"][oid] for row in regional_rows}
    local_ids = {row["attributes"][oid] for row in local_rows}
    if regional_ids & local_ids:
        raise RuntimeError("Regional and local snapshots overlap")
    county = {"type": "Feature", "geometry": atlas["county"], "properties": {
        "kind": "county", "tier": "county", "name": "Pinellas County", "sourceId": "census:12103"}}
    regional = [road_feature(row, oid, "regional", 0.0001) for row in regional_rows]
    local_roads = [road_feature(row, oid, "local", 0.00003) for row in local_rows]
    water = [{**feature, "properties": {"kind": "water", "tier": "local", "name": str(feature.get("properties", {}).get("name") or ""),
              "sourceId": str(feature.get("properties", {}).get("sourceId") or f"nhd-cached:{i}")}}
             for i, feature in enumerate(local["features"]) if feature.get("properties", {}).get("kind") == "water"]
    data = compact({"type": "FeatureCollection", "bbox": BBOX, "features": [county, *regional, *water]})
    entries = tile_features(local_roads)
    manifest = {"schemaVersion": 1, "crs": "EPSG:4326", "tileSizeDegrees": GRID, "bbox": BBOX,
                "note": "Grid cells load county source roads. Whole paths repeat at tile edges; deduplicate sourceId. No access or official boundary is asserted.",
                "uniqueFeatureCount": len(local_roads), "tiles": entries}
    manifest_bytes = compact(manifest)
    (OUT/"context.geojson").write_bytes(data)
    (OUT/"context-tiles.json").write_bytes(manifest_bytes)
    counts = {"county": 1, "regionalRoad": len(regional), "localRoad": len(local_roads), "water": len(water), "localTiles": len(entries)}
    notices = {"schemaVersion": 1, "attribution": "U.S. Census Bureau; Pinellas County GIS; USGS.",
        "coverage": {"countyOutline": "Pinellas County land, Census 2024 cartographic boundary at 1:500,000; generalized orientation silhouette.",
            "regionalRoads": "All regional classes intersecting the county bounding envelope, generalized at 0.0001 degrees.",
            "localRoads": "All remaining road classes intersecting that envelope, tiled for lazy loading and generalized at 0.00003 degrees.",
            "water": "21 retained USGS features in the two-neighborhood St. Petersburg snapshot only. County coastline comes from Census; inland water coverage is not countywide."},
        "sources": [
            {"label": "U.S. Census Bureau", "url": "https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_county_500k.zip",
             "notice": "Public-domain 2024 cartographic land boundary, FIPS 12103, extracted in the existing atlas. Generalized, not site precision.",
             "retainedAtlasSha256": sha(atlas_bytes), "provenance": "/prototypes/pinellas-atlas/provenance.md"},
            {"label": "Pinellas County GIS", "url": ROAD_SERVICE, "metadataSha256": sha(metadata_raw),
             "regional": regional_evidence, "local": local_evidence,
             "notice": "Source metadata declares no general open license. Reference use only; offered as-is without accuracy/completeness warranty; not survey precision. Road class does not establish public access or a route."},
            {"label": "USGS", "url": "https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer",
             "retainedContextSha256": sha(local_bytes), "notice": "National Hydrography Dataset: open and non-proprietary; acknowledge USGS. Retained water is local, temporally variable, and not for site-specific regulatory determinations."}],
        "simplification": {"method": "Source maxAllowableOffset, then Douglas-Peucker per path; retain endpoints and round coordinates to 6 decimals", "regionalDegrees": 0.0001, "localDegrees": 0.00003},
        "featureCounts": counts, "bbox": BBOX, "publicSha256": sha(data), "publicBytes": len(data),
        "tileManifestSha256": sha(manifest_bytes), "tileBytesTotal": sum(entry["bytes"] for entry in entries),
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat()}
    (OUT/"source-notices.json").write_bytes(compact(notices))
    (EVIDENCE/"build-evidence.json").write_bytes(compact(notices))
    print(json.dumps({"counts": counts, "contextBytes": len(data), "tileBytes": notices["tileBytesTotal"],
                      "tiles": len(entries), "maxTileBytes": max(entry["bytes"] for entry in entries)}, indent=2))


if __name__ == "__main__":
    main()
