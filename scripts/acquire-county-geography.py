#!/usr/bin/env python3
"""Acquire review snapshots of Pinellas boundaries, roads, and NHD water layers.

This tool only prepares raw source snapshots. It does not create application maps.
"""
import argparse
import datetime as dt
import hashlib
import json
import math
import os
import pathlib
import shutil
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

FDOT_LAYER = "https://gis.fdot.gov/arcgis/rest/services/Admin_Boundaries/FeatureServer/7"
ROADS_LAYER = "https://services.arcgis.com/f5HgUpxURgEzTccH/ArcGIS/rest/services/Pinellas_RoadCenterline_view/FeatureServer/0"
NHD_SERVICE = "https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer"


class AcquisitionError(RuntimeError):
    pass


def get_json(url, fetch=None):
    if fetch:
        raw = fetch(url)
    else:
        request = urllib.request.Request(url, headers={"User-Agent": "this-way-geography-acquisition/1.0"})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                raw = response.read()
        except (urllib.error.URLError, TimeoutError) as exc:
            raise AcquisitionError(f"request failed: {url}: {exc}") from exc
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError, TypeError) as exc:
        raise AcquisitionError(f"invalid JSON from {url}") from exc
    if not isinstance(data, dict) or "error" in data:
        raise AcquisitionError(f"source returned error payload from {url}: {data.get('error') if isinstance(data, dict) else 'not an object'}")
    return data, raw


def url_with(url, params):
    return url + ("&" if "?" in url else "?") + urllib.parse.urlencode(params)


def metadata(url, fetch=None):
    result, raw = get_json(url + ("&" if "?" in url else "?") + "f=pjson", fetch)
    return result, hashlib.sha256(raw).hexdigest(), raw


def name_field(meta, override=None):
    fields = meta.get("fields")
    if not isinstance(fields, list):
        raise AcquisitionError("boundary service metadata has no fields list")
    if override:
        matches = [f for f in fields if str(f.get("name", "")).casefold() == override.casefold()
                   and str(f.get("type", "")).lower().endswith("string")]
        if len(matches) != 1:
            raise AcquisitionError(f"configured boundary name field {override!r} is absent or not a string")
        return matches[0]["name"]
    candidates = [f for f in fields if "name" in (str(f.get("name", "")) + " " + str(f.get("alias", ""))).lower() and str(f.get("type", "")).lower().endswith("string")]
    if len(candidates) != 1:
        raise AcquisitionError(f"could not identify one boundary name field from metadata (found {len(candidates)}); pass --boundary-name-field after inspecting metadata")
    return candidates[0]["name"]


def arcgis_query(base, params, fetch=None):
    data, _ = get_json(url_with(base.rstrip("/") + "/query", {**params, "f": "json"}), fetch)
    return data


def acquire_layer(base, extent, fetch=None, allow_empty=False):
    meta, meta_sha, meta_raw = metadata(base, fetch)
    oid = meta.get("objectIdField") or meta.get("objectIdFieldName")
    if not oid:
        oid_fields = [f["name"] for f in meta.get("fields", []) if f.get("type") == "esriFieldTypeOID"]
        if len(oid_fields) != 1:
            raise AcquisitionError(f"cannot identify stable object ID in {base}")
        oid = oid_fields[0]
    page_size = meta.get("maxRecordCount")
    if not isinstance(page_size, int) or page_size < 1:
        raise AcquisitionError(f"invalid maxRecordCount in {base}")
    # A service's record limit can exceed practical GET URL lengths for an ID list.
    page_size = min(page_size, 200)
    ids_result = arcgis_query(base, {"where": "1=1", "geometry": extent, "geometryType": "esriGeometryEnvelope", "spatialRel": "esriSpatialRelIntersects", "returnIdsOnly": "true", "returnGeometry": "false", "inSR": 4326, "outSR": 4326}, fetch)
    if ids_result.get("exceededTransferLimit"):
        raise AcquisitionError(f"source ID query exceeded transfer limit in {base}")
    ids = ids_result.get("objectIds")
    if not isinstance(ids, list) or any(type(value) is not int for value in ids) or len(ids) != len(set(ids)):
        raise AcquisitionError(f"missing or duplicate object IDs in {base}")
    ids = sorted(ids)
    if not ids and not allow_empty:
        raise AcquisitionError(f"empty source query result in {base}")
    all_features = []
    for start in range(0, len(ids), page_size):
        batch = ids[start:start + page_size]
        page = arcgis_query(base, {"objectIds": ",".join(map(str, batch)), "outFields": "*", "returnGeometry": "true", "where": "1=1", "inSR": 4326, "outSR": 4326}, fetch)
        if page.get("exceededTransferLimit"):
            raise AcquisitionError(f"transfer limit exceeded despite object-ID paging in {base}")
        rows = page.get("features")
        if not isinstance(rows, list):
            raise AcquisitionError(f"page has no feature list in {base}")
        got = [f.get("attributes", {}).get(oid) for f in rows]
        if len(rows) != len(batch) or sorted(got) != batch or len(got) != len(set(got)):
            raise AcquisitionError(f"page ID mismatch in {base}")
        all_features.extend(rows)
        sr = page.get("spatialReference") or (rows[0].get("geometry", {}).get("spatialReference") if rows else None)
        if not sr or (sr.get("wkid") != 4326 and sr.get("latestWkid") != 4326):
            raise AcquisitionError(f"unexpected response spatial reference in {base}: {sr}")
    seen = [f.get("attributes", {}).get(oid) for f in all_features]
    if len(seen) != len(ids) or sorted(seen) != ids:
        raise AcquisitionError(f"retrieved IDs differ from source ID list in {base}")
    return {"serviceUrl": base, "metadataSha256": meta_sha, "metadata": meta, "metadataRaw": meta_raw, "geometryType": meta.get("geometryType"), "objectIdField": oid, "expectedFeatureCount": len(ids), "retrievedFeatureCount": len(all_features), "features": all_features}


def field_binding(meta, override=None, purpose="name"):
    fields = meta.get("fields", [])
    if override:
        matches = [f for f in fields if f.get("name", "").casefold() == override.casefold()]
        if len(matches) != 1:
            raise AcquisitionError(f"configured {purpose} field {override!r} is absent from source metadata")
        return matches[0]["name"]
    # Bind from actual source metadata only. Multiple plausible fields require an explicit override.
    token = "name" if purpose == "road-name" else "class"
    candidates = [f for f in fields if f.get("type", "").endswith("String") and token in (str(f.get("name", "")) + " " + str(f.get("alias", ""))).casefold()]
    if len(candidates) != 1:
        raise AcquisitionError(f"could not identify one {purpose} field from metadata (found {len(candidates)}); pass --{purpose}-field")
    return candidates[0]["name"]


def geojson_geometry(geometry, geometry_type):
    if not geometry:
        raise AcquisitionError("source feature has no geometry")
    if geometry_type in ("esriGeometryPolygon", "esriGeometryMultipolygon"):
        rings = geometry.get("rings")
        if not isinstance(rings, list) or not rings:
            raise AcquisitionError("polygon geometry has no rings")
        shells, holes = [], []
        for ring in rings:
            if not isinstance(ring, list) or len(ring) < 4:
                raise AcquisitionError("polygon ring is too short")
            for point in ring:
                if not isinstance(point, (list, tuple)) or len(point) < 2 or any(type(v) not in (int, float) or not math.isfinite(v) for v in point[:2]):
                    raise AcquisitionError("polygon contains invalid or nonfinite XY coordinate")
            if ring[0][:2] != ring[-1][:2]:
                raise AcquisitionError("polygon ring is not closed")
            area = sum(ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1] for i in range(len(ring) - 1))
            if not math.isfinite(area) or area == 0:
                raise AcquisitionError("polygon ring has zero or invalid area")
            (shells if area < 0 else holes).append(ring)
        if not shells:
            raise AcquisitionError("polygon rings have no Esri clockwise outer ring")
        polygons = [[shell] for shell in shells]
        for hole in holes:
            point = hole[0]
            owners = [i for i, polygon in enumerate(polygons) if point_in_ring(point, polygon[0])]
            if len(owners) != 1:
                raise AcquisitionError("ambiguous polygon hole ownership")
            polygons[owners[0]].append(hole)
        return {"type": "Polygon", "coordinates": polygons[0]} if len(polygons) == 1 else {"type": "MultiPolygon", "coordinates": polygons}
    if geometry_type == "esriGeometryPolyline":
        paths = geometry.get("paths")
        if not isinstance(paths, list) or not paths:
            raise AcquisitionError("polyline geometry has no paths")
        if any(not isinstance(path, list) or len(path) < 2 or any(not isinstance(point, (list, tuple)) or len(point) < 2 or any(type(v) not in (int, float) or not math.isfinite(v) for v in point[:2]) for point in path) for path in paths):
            raise AcquisitionError("polyline contains invalid or nonfinite coordinates")
        return {"type": "LineString", "coordinates": paths[0]} if len(paths) == 1 else {"type": "MultiLineString", "coordinates": paths}
    raise AcquisitionError(f"unsupported geometry type: {geometry_type}")


def point_in_ring(point, ring):
    x, y = point[:2]
    inside = False
    for i in range(len(ring) - 1):
        x1, y1 = ring[i][:2]
        x2, y2 = ring[i + 1][:2]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def feature_collection(rows, geometry_type, property_fn):
    return {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": geojson_geometry(row.get("geometry"), geometry_type), "properties": property_fn(row.get("attributes", {}))} for row in rows]}


def run(args, fetch=None, now=None):
    output = pathlib.Path(args.output).resolve()
    public = pathlib.Path(__file__).resolve().parents[1] / "public"
    if output == public or public in output.parents:
        raise AcquisitionError("output must be outside public/")
    if output.exists():
        raise AcquisitionError(f"refusing to overwrite existing snapshot set: {output}")

    core_url, roads_url, nhd_url = args.fdot_layer, args.roads_layer, args.nhd_service
    core_meta, core_sha, core_meta_raw = metadata(core_url, fetch)
    field = name_field(core_meta, args.boundary_name_field)
    escaped = args.name.replace("'", "''")
    core_result = arcgis_query(core_url, {"where": f"{field}='{escaped}'", "outFields": "*", "returnGeometry": "true", "returnDistinctValues": "false", "outSR": 4326}, fetch)
    if core_result.get("geometryType") not in ("esriGeometryPolygon", "esriGeometryMultipolygon"):
        raise AcquisitionError(f"unsupported core boundary geometry type: {core_result.get('geometryType')}")
    core_rows = core_result.get("features")
    if not isinstance(core_rows, list):
        raise AcquisitionError("boundary query returned no feature list")
    # Case-insensitive exact attribute check guards services that ignore/normalize where clauses.
    if core_result.get("exceededTransferLimit"):
        raise AcquisitionError("core boundary query exceeded transfer limit")
    core_rows = [f for f in core_rows if str(f.get("attributes", {}).get(field, "")).casefold() == args.name.casefold()]
    if len(core_rows) != 1:
        raise AcquisitionError(f"expected exactly one exact-name core boundary, found {len(core_rows)}")
    geom = core_rows[0].get("geometry")
    if not geom or "rings" not in geom:
        raise AcquisitionError("boundary geometry lacks rings; only Polygon/MultiPolygon ring geometry is supported")
    sr = geom.get("spatialReference") or core_result.get("spatialReference")
    if not sr or (sr.get("wkid") != 4326 and sr.get("latestWkid") != 4326):
        raise AcquisitionError(f"unexpected core response spatial reference: {sr}")
    bbox = geom.get("extent")
    if not bbox:
        coords = [p for ring in geom["rings"] for p in ring]
        if not coords:
            raise AcquisitionError("boundary has empty rings")
        bbox = {"xmin": min(p[0] for p in coords), "ymin": min(p[1] for p in coords), "xmax": max(p[0] for p in coords), "ymax": max(p[1] for p in coords)}
    if not (-83.1 <= bbox["xmin"] <= -82.3 and -83.1 <= bbox["xmax"] <= -82.3 and 27.4 <= bbox["ymin"] <= 28.3 and 27.4 <= bbox["ymax"] <= 28.3):
        raise AcquisitionError(f"core boundary is outside the Pinellas County coordinate guard: {bbox}")
    # ~150m padding in degrees; retained as an explicit approximation for this local research workflow.
    lat = (bbox["ymin"] + bbox["ymax"]) / 2
    dx = 0.0015 / max(0.2, math.cos(math.radians(lat)))
    dy = 0.0015
    padded = {"xmin": bbox["xmin"] - dx, "ymin": bbox["ymin"] - dy, "xmax": bbox["xmax"] + dx, "ymax": bbox["ymax"] + dy}
    extent_arg = ",".join(str(padded[k]) for k in ("xmin", "ymin", "xmax", "ymax"))

    nhd_meta, nhd_sha, nhd_meta_raw = metadata(nhd_url, fetch)
    layers = nhd_meta.get("layers")
    if not isinstance(layers, list):
        raise AcquisitionError("NHD metadata has no layers list")
    wanted = {"nhdwaterbody", "nhdarea"}
    selected = {}
    for layer in layers:
        lname = str(layer.get("name", "")).casefold()
        if lname in wanted:
            selected[lname] = layer.get("id")
    if set(selected) != wanted:
        raise AcquisitionError(f"NHD metadata missing exact required layers: {sorted(wanted - set(selected))}")

    core = {"serviceUrl": core_url, "metadataSha256": core_sha, "nameField": field, "query": {"where": f"{field}='{escaped}'", "outFields": "*"}, "requestedName": args.name, "expectedFeatureCount": 1, "retrievedFeatureCount": 1, "feature": core_rows[0]}
    roads = acquire_layer(roads_url, extent_arg, fetch)
    road_name = field_binding(roads["metadata"], args.road_name_field, "road-name")
    road_class = field_binding(roads["metadata"], args.road_class_field, "road-class") if args.road_class_field else None
    # Include only geometry plus stable ID, street name, class and a recognized centerline ID.
    centerline_candidates = [f["name"] for f in roads["metadata"].get("fields", []) if "centerline" in (f.get("name", "") + " " + f.get("alias", "")).casefold() and f.get("type", "").endswith("String")]
    centerline = centerline_candidates[0] if len(centerline_candidates) == 1 else None
    road_properties = lambda a: {k: a[k] for k in [roads["objectIdField"], road_name, *([road_class] if road_class else []), *([centerline] if centerline else [])] if k in a}
    water = {}
    for lname, layer_id in selected.items():
        water[lname] = acquire_layer(nhd_url.rstrip("/") + "/" + str(layer_id), extent_arg, fetch, allow_empty=True)
        if water[lname]["geometryType"] not in ("esriGeometryPolygon", "esriGeometryMultipolygon"):
            raise AcquisitionError(f"unsupported NHD polygon layer geometry type for {lname}: {water[lname]['geometryType']}")
    acquired_at = (now or dt.datetime.now(dt.timezone.utc)).astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    snapshot = {"schemaVersion": 1, "candidate": {"id": args.candidate_id, "name": args.name}, "acquiredAt": acquired_at, "spatialQuery": {"sourceBoundaryExtent": bbox, "bufferDegreesApprox150m": {"longitude": dx, "latitude": dy}, "extent": padded, "note": "Approximate 150 m degree buffer; source boundary rings are retained unchanged."}, "sources": {"coreBoundary": core, "roads": roads, "nhdService": {"serviceUrl": nhd_url, "metadataSha256": nhd_sha, "layers": water}}, "bindings": {"boundaryNameField": field, "roadObjectIdField": roads["objectIdField"], "roadNameField": road_name, "roadClassField": road_class, "roadCenterlineIdField": centerline}}
    water_rows = [(lname, layer, feature) for lname, layer in water.items() for feature in layer["features"]]
    water_fc = {"type": "FeatureCollection", "features": [{
        "type": "Feature", "id": f"{lname}:{feature['attributes'][layer['objectIdField']]}",
        "geometry": geojson_geometry(feature.get("geometry"), layer["geometryType"]),
        "properties": feature.get("attributes", {}),
    } for lname, layer, feature in water_rows]}

    # Serialize and validate every artifact before making the final directory visible.
    artifacts = {
        "raw/boundary-metadata.json": core_meta_raw,
        "raw/roads-metadata.json": roads.pop("metadataRaw"),
        "raw/nhd-service-metadata.json": nhd_meta_raw,
        "raw/boundary-source-feature.json": (json.dumps(core_rows[0], indent=2) + "\n").encode(),
        "raw/roads-source-features.json": (json.dumps(roads["features"], indent=2) + "\n").encode(),
        "raw/water-source-features.json": (json.dumps({k: v["features"] for k, v in water.items()}, indent=2) + "\n").encode(),
        "boundary.geojson": (json.dumps(feature_collection([core_rows[0]], core_result["geometryType"], lambda a: a), indent=2) + "\n").encode(),
        "roads.geojson": (json.dumps(feature_collection(roads["features"], roads["geometryType"], road_properties), indent=2) + "\n").encode(),
        "water.geojson": (json.dumps(water_fc, indent=2) + "\n").encode(),
    }
    for lname, layer in water.items():
        artifacts[f"raw/{lname}-metadata.json"] = layer.pop("metadataRaw")
    snapshot["filesSha256"] = {name: hashlib.sha256(data).hexdigest() for name, data in sorted(artifacts.items())}
    artifacts["manifest.json"] = (json.dumps(snapshot, indent=2) + "\n").encode()
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = pathlib.Path(tempfile.mkdtemp(prefix=f".{output.name}-", dir=output.parent))
    try:
        for name, data in artifacts.items():
            path = staging / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        os.rename(staging, output)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return snapshot


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", required=True, help="Exact candidate boundary name")
    parser.add_argument("--candidate-id", required=True, help="Review-only candidate ID")
    parser.add_argument("--output", required=True, help="New snapshot directory outside public/")
    parser.add_argument("--fdot-layer", default=FDOT_LAYER)
    parser.add_argument("--roads-layer", default=ROADS_LAYER)
    parser.add_argument("--nhd-service", default=NHD_SERVICE)
    parser.add_argument("--boundary-name-field", help="Exact string field from inspected boundary service metadata")
    parser.add_argument("--road-name-field", help="Exact source metadata field for street name")
    parser.add_argument("--road-class-field", help="Exact source metadata field for road class")
    args = parser.parse_args()
    try:
        snapshot = run(args)
    except (AcquisitionError, OSError) as exc:
        print(f"acquisition failed: {exc}", file=sys.stderr)
        return 2
    print(f"saved review snapshot for {snapshot['candidate']['name']} to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
