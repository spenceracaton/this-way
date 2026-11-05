#!/usr/bin/env python3
"""Build the small, renderer-neutral base geography for the continuous-map spike.

The public package contains only road and water linework, safe display names,
source IDs, and explicit source notices. Metadata and source-feature evidence is
kept outside public/ under design-review/continuous-canvas/source/.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import math
import os
import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
ROADS_URL = "https://services.arcgis.com/f5HgUpxURgEzTccH/ArcGIS/rest/services/Pinellas_RoadCenterline_view/FeatureServer/0"
NHD_URL = "https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer"
EXTENT = {"xmin": -82.654064, "ymin": 27.768825, "xmax": -82.612147, "ymax": 27.808279}
SIMPLIFY_DEGREES = 0.00005  # ~5 m here; suited to a neighborhood basemap at prototype scale.


def load_acquisition_primitives():
    path = ROOT / "scripts" / "acquire-county-geography.py"
    spec = importlib.util.spec_from_file_location("county_geography_acquisition", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def encoded(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n").encode()


def distance_to_segment(point, start, end):
    px, py = point[:2]
    x1, y1 = start[:2]
    x2, y2 = end[:2]
    dx, dy = x2 - x1, y2 - y1
    if dx == dy == 0:
        return math.hypot(px - x1, py - y1)
    ratio = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (x1 + ratio * dx), py - (y1 + ratio * dy))


def simplify_path(points, tolerance, closed=False):
    """Douglas-Peucker per path; retain a ring unchanged if simplification degenerates."""
    points = [[round(float(value), 6) for value in point[:2]] for point in points]
    if closed:
        if points[0] != points[-1]:
            points.append(points[0][:])
        body = points[:-1]
        if len(body) < 4:
            return points
        # Split at a farthest vertex to avoid treating a closed ring as a zero-length chord.
        a = body[0]
        far = max(range(1, len(body)), key=lambda i: (body[i][0] - a[0]) ** 2 + (body[i][1] - a[1]) ** 2)
        first = body[:far + 1]
        second = body[far:] + [body[0]]
        simplified = simplify_path(first, tolerance)[:-1] + simplify_path(second, tolerance)
        if len(simplified) < 4 or simplified[0] != simplified[-1]:
            return points
        signed_area2 = sum(simplified[i][0] * simplified[i + 1][1] - simplified[i + 1][0] * simplified[i][1] for i in range(len(simplified) - 1))
        if signed_area2 == 0:
            return points
        return simplified
    if len(points) <= 2:
        return points
    keep = {0, len(points) - 1}
    stack = [(0, len(points) - 1)]
    while stack:
        start, end = stack.pop()
        best_i, best_d = None, tolerance
        for i in range(start + 1, end):
            d = distance_to_segment(points[i], points[start], points[end])
            if d > best_d:
                best_i, best_d = i, d
        if best_i is not None:
            keep.add(best_i)
            stack.extend(((start, best_i), (best_i, end)))
    return [point for i, point in enumerate(points) if i in keep]


def simplify_geometry(geometry, tolerance):
    kind, coords = geometry["type"], geometry["coordinates"]
    if kind == "LineString":
        return {"type": kind, "coordinates": simplify_path(coords, tolerance)}
    if kind == "MultiLineString":
        return {"type": kind, "coordinates": [simplify_path(path, tolerance) for path in coords]}
    if kind == "Polygon":
        return {"type": kind, "coordinates": [simplify_path(ring, tolerance, True) for ring in coords]}
    if kind == "MultiPolygon":
        return {"type": kind, "coordinates": [[simplify_path(ring, tolerance, True) for ring in polygon] for polygon in coords]}
    raise ValueError(f"unexpected source geometry type {kind}")


def clip_features_with_gdal(features):
    """Clip to a rectangle with GDAL/GEOS so polygon holes and multipart parts survive."""
    with tempfile.TemporaryDirectory(prefix="continuous-context-clip-") as temp:
        temp = pathlib.Path(temp)
        source, clipped = temp / "source.geojson", temp / "clipped.geojson"
        source.write_bytes(encoded({"type": "FeatureCollection", "features": features}))
        command = ["ogr2ogr", "-f", "GeoJSON", "-lco", "RFC7946=YES", "-clipsrc",
                   *(str(EXTENT[key]) for key in ("xmin", "ymin", "xmax", "ymax")),
                   str(clipped), str(source)]
        try:
            subprocess.run(command, check=True, capture_output=True, text=True)
        except FileNotFoundError as exc:
            raise RuntimeError("GDAL ogr2ogr is required to clip geometry to the approved extent") from exc
        except subprocess.CalledProcessError as exc:
            raise RuntimeError(f"GDAL clipping failed: {exc.stderr.strip()}") from exc
        result = json.loads(clipped.read_text())
        rows = result.get("features")
        if not isinstance(rows, list):
            raise RuntimeError("GDAL clipping did not return a FeatureCollection")
        return rows


def fetch_layers(acq, base, extent, fields, expected_type, allow_empty=False):
    meta, meta_hash, meta_raw = acq.metadata(base)
    if meta.get("geometryType") != expected_type:
        raise acq.AcquisitionError(f"unexpected geometry type for {base}: {meta.get('geometryType')}")
    oid = meta.get("objectIdField") or meta.get("objectIdFieldName")
    if not oid:
        candidates = [f["name"] for f in meta.get("fields", []) if f.get("type") == "esriFieldTypeOID"]
        if len(candidates) != 1:
            raise acq.AcquisitionError(f"cannot identify object ID in {base}")
        oid = candidates[0]
    request_fields = list(dict.fromkeys([oid, *fields]))
    snapshot = acq.acquire_layer(base, ",".join(str(extent[k]) for k in ("xmin", "ymin", "xmax", "ymax")),
                                 metadata_snapshot=(meta, meta_hash, meta_raw), requested_fields=request_fields,
                                 allow_empty=allow_empty)
    # The county source's own metadata describes a reference data set, not survey-grade control.
    return snapshot


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=str(ROOT / "public/prototypes/continuous-map/data/context.geojson"))
    parser.add_argument("--evidence", default=str(ROOT.parent / "design-review/continuous-canvas/source"))
    args = parser.parse_args()
    output, evidence = pathlib.Path(args.output).resolve(), pathlib.Path(args.evidence).resolve()
    public = (ROOT / "public").resolve()
    if output == public or public not in output.parents:
        raise ValueError("public context output must remain under public/")
    if evidence == public or public in evidence.parents:
        raise ValueError("source evidence must remain outside public/")

    acq = load_acquisition_primitives()
    roads_meta, roads_meta_hash, roads_meta_raw = acq.metadata(ROADS_URL)
    fields_by_lower = {str(field.get("name", "")).casefold(): field["name"] for field in roads_meta.get("fields", [])}
    for field in ("objectid", "fullname", "roadclass", "centerlineid"):
        if field not in fields_by_lower:
            raise acq.AcquisitionError(f"road service metadata is missing required safe field {field}")
    road_snapshot = acq.acquire_layer(
        ROADS_URL, ",".join(str(EXTENT[k]) for k in ("xmin", "ymin", "xmax", "ymax")),
        metadata_snapshot=(roads_meta, roads_meta_hash, roads_meta_raw),
        requested_fields=[fields_by_lower[k] for k in ("objectid", "fullname", "roadclass", "centerlineid")])

    nhd_meta, nhd_meta_hash, nhd_meta_raw = acq.metadata(NHD_URL)
    area = [layer for layer in nhd_meta.get("layers", []) if str(layer.get("name", "")).strip().casefold() == "area - large scale"]
    waterbody = [layer for layer in nhd_meta.get("layers", []) if str(layer.get("name", "")).strip().casefold() == "waterbody - large scale"]
    if len(area) != 1 or len(waterbody) != 1:
        raise acq.AcquisitionError("NHD metadata did not identify one large-scale area and waterbody layer")
    water_snapshots = []
    for layer in (area[0], waterbody[0]):
        base = f"{NHD_URL}/{layer['id']}"
        meta, meta_hash, meta_raw = acq.metadata(base)
        layer_fields = {str(f.get("name", "")).casefold(): f["name"] for f in meta.get("fields", [])}
        oid = meta.get("objectIdField") or meta.get("objectIdFieldName")
        if not oid:
            oid_fields = [f["name"] for f in meta.get("fields", []) if f.get("type") == "esriFieldTypeOID"]
            if len(oid_fields) != 1:
                raise acq.AcquisitionError(f"cannot identify object ID in {base}")
            oid = oid_fields[0]
        wanted = [layer_fields[k] for k in ("gnis_name", "permanent_identifier", "ftype", "fcode") if k in layer_fields]
        water_snapshots.append((layer, acq.acquire_layer(
            base, ",".join(str(EXTENT[k]) for k in ("xmin", "ymin", "xmax", "ymax")),
            metadata_snapshot=(meta, meta_hash, meta_raw), requested_fields=[oid, *wanted], allow_empty=True)))

    features = []
    evidence_values = {}
    road_rows = road_snapshot["features"]
    evidence_values["roads-features.json"] = road_rows
    for row in road_rows:
        attributes = row.get("attributes", {})
        geometry = acq.geojson_geometry(row.get("geometry"), road_snapshot["geometryType"])
        features.append({"type": "Feature", "geometry": geometry, "properties": {
            "kind": "road", "name": str(attributes.get(fields_by_lower["fullname"]) or ""),
            "source": "Pinellas County GIS", "sourceId": f"pinellas-road:{attributes[fields_by_lower['objectid']]}"
        }})
    for layer, snapshot in water_snapshots:
        rows = snapshot["features"]
        evidence_values[f"nhd-layer-{layer['id']}-features.json"] = rows
        attr_names = {str(f.get("name", "")).casefold(): f["name"] for f in snapshot["metadata"].get("fields", [])}
        oid = snapshot["objectIdField"]
        for row in rows:
            attributes = row.get("attributes", {})
            name_field = attr_names.get("gnis_name")
            geometry = acq.geojson_geometry(row.get("geometry"), snapshot["geometryType"])
            features.append({"type": "Feature", "geometry": geometry, "properties": {
                "kind": "water", "name": str(attributes.get(name_field) or "") if name_field else "",
                "source": "USGS", "sourceId": f"nhd-{layer['id']}:{attributes[oid]}"
            }})

    source_feature_count = len(features)
    features = clip_features_with_gdal(features)
    if len(features) != source_feature_count:
        raise RuntimeError(f"clipping changed feature count from {source_feature_count} to {len(features)}")
    for feature in features:
        feature["geometry"] = simplify_geometry(feature["geometry"], SIMPLIFY_DEGREES)
    collection = {"type": "FeatureCollection", "bbox": [EXTENT["xmin"], EXTENT["ymin"], EXTENT["xmax"], EXTENT["ymax"]], "features": features}
    data_bytes = encoded(collection)
    evidence_payloads = {
        "roads-metadata.json": roads_meta_raw,
        "nhd-service-metadata.json": nhd_meta_raw,
        "roads-features.json": encoded(evidence_values["roads-features.json"]),
    }
    for layer, snapshot in water_snapshots:
        evidence_payloads[f"nhd-layer-{layer['id']}-metadata.json"] = snapshot["metadataRaw"]
        evidence_payloads[f"nhd-layer-{layer['id']}-features.json"] = encoded(evidence_values[f"nhd-layer-{layer['id']}-features.json"])
    notices = {
        "schemaVersion": 1,
        "attribution": "Pinellas County GIS; USGS.",
        "license": None,
        "licenseNotes": {
            "pinellasRoads": "The source metadata does not declare a license. Existing project source notices record Pinellas County Business Technology Services, Enterprise GIS as steward and these constraints: offered as-is with no accuracy/completeness warranty; reference use only; not survey precision. No open-license grant is asserted here.",
            "usgsNhd": "The NHD service metadata says the dataset is open and non-proprietary, states no use constraints, and requests acknowledgment of USGS. It also warns of temporal change and excludes site-specific regulatory determinations."
        },
        "coverage": {"extent": EXTENT, "crs": "EPSG:4326", "queryRelation": "intersects", "displayGeometryClippedToExtent": True, "note": "Display derivative is clipped to this rectangle; full intersecting source geometry is retained in external evidence snapshots."},
        "acquiredAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "sources": [
            {"label": "Pinellas County GIS", "url": ROADS_URL, "note": "County road centerlines; source metadata has no explicit license. Existing project notices record Pinellas County Business Technology Services, Enterprise GIS as steward and these constraints: offered as-is with no accuracy/completeness warranty; reference use only; not survey precision. No open-license grant is asserted.", "evidence": {"featureCount": len(road_rows), "metadataSha256": sha256(roads_meta_raw), "dataSnapshotSha256": sha256(evidence_payloads["roads-features.json"]), "requestedFields": ["OBJECTID", "FULLNAME", "ROADCLASS", "CENTERLINEID"]}},
            {"label": "USGS", "url": NHD_URL, "note": "U.S. Geological Survey National Hydrography Dataset. Service metadata says open and non-proprietary, states no use constraints, and requests acknowledgment of USGS; it warns of temporal change and excludes site-specific regulatory determinations.", "evidence": {"featureCount": sum(len(s["features"]) for _, s in water_snapshots), "metadataSha256": sha256(nhd_meta_raw), "layers": [{"id": layer["id"], "name": layer["name"], "url": f"{NHD_URL}/{layer['id']}", "featureCount": len(snapshot["features"]), "metadataSha256": snapshot["metadataSha256"], "dataSnapshotSha256": sha256(evidence_payloads[f"nhd-layer-{layer['id']}-features.json"])} for layer, snapshot in water_snapshots]}}
        ],
        "simplification": {"method": "GDAL/GEOS rectangle clip to extent, then Douglas-Peucker independently per line and polygon ring; coordinates rounded to 6 decimal places", "toleranceDegrees": SIMPLIFY_DEGREES, "approximateToleranceMeters": 5, "featureCountPreserved": True, "lineEndpointsPreserved": True, "polygonRingClosurePreserved": True, "caveat": "Visual basemap derivative for the local prototype; source geometry is retained in the design-review evidence folder."},
        "featureCounts": {"road": len(road_rows), "water": len(features) - len(road_rows), "total": len(features)},
        "publicFeatureCollectionSha256": sha256(data_bytes),
        "publicFeatureCollectionBytes": len(data_bytes),
        "sourceEvidence": {name: sha256(value) for name, value in sorted(evidence_payloads.items())}
    }
    notice_bytes = encoded(notices)
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = pathlib.Path(tempfile.mkdtemp(prefix=f".{output.name}-", dir=output.parent))
    try:
        staged_geojson = stage / output.name
        staged_notices = stage / "source-notices.json"
        staged_geojson.write_bytes(data_bytes)
        staged_notices.write_bytes(notice_bytes)
        # Replace only the two artifacts owned by this script; preserve sibling prototype assets.
        os.replace(staged_geojson, output)
        os.replace(staged_notices, output.parent / "source-notices.json")
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    evidence.mkdir(parents=True, exist_ok=True)
    for name, value in evidence_payloads.items():
        (evidence / name).write_bytes(value)
    print(json.dumps({"output": str(output), "featureCounts": notices["featureCounts"], "bytes": len(data_bytes), "extent": EXTENT, "attribution": notices["attribution"]}, indent=2))


if __name__ == "__main__":
    main()
