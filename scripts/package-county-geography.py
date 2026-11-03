#!/usr/bin/env python3
"""Package a verified county acquisition snapshot as reusable geography."""
import argparse
import datetime as dt
import hashlib
import json
import math
import os
import pathlib
import re
import shutil
import sys
import tempfile
from urllib.parse import urlparse


class PackageError(RuntimeError):
    pass


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise PackageError(f"cannot read valid JSON: {path}") from exc


def source_file(root, relative):
    rel = pathlib.PurePosixPath(relative)
    if rel.is_absolute() or ".." in rel.parts or not rel.parts:
        raise PackageError(f"snapshot file path is not contained: {relative}")
    root_real = root.resolve(strict=True)
    path = (root / pathlib.Path(*rel.parts)).resolve(strict=True)
    try:
        path.relative_to(root_real)
    except ValueError as exc:
        raise PackageError(f"snapshot file path escapes snapshot root: {relative}") from exc
    if not path.is_file():
        raise PackageError(f"snapshot file is not a regular file: {relative}")
    return path


def verified_snapshot(snapshot_path):
    root = pathlib.Path(snapshot_path).resolve(strict=True)
    manifest_path = source_file(root, "manifest.json")
    manifest_bytes = manifest_path.read_bytes()
    manifest = read_json(manifest_path)
    hashes = manifest.get("filesSha256")
    if not isinstance(hashes, dict) or not hashes:
        raise PackageError("snapshot manifest has no file checksum map")
    files = {}
    for relative, expected in hashes.items():
        path = source_file(root, relative)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if not isinstance(expected, str) or digest != expected:
            raise PackageError(f"snapshot checksum mismatch: {relative}")
        files[relative] = path
    return root, manifest, files, hashlib.sha256(manifest_bytes).hexdigest()


def checked_geometry(geometry, allowed, context):
    if not isinstance(geometry, dict) or geometry.get("type") not in allowed:
        raise PackageError(f"unsupported geometry type for {context}: {geometry.get('type') if isinstance(geometry, dict) else None}")
    geometry_type = geometry["type"]
    coordinates = geometry.get("coordinates")
    dimensions = set()

    def position(value, label):
        if (not isinstance(value, list) or len(value) not in (2, 3) or
                any(type(item) not in (int, float) or not math.isfinite(item) for item in value)):
            raise PackageError(f"invalid geographic position for {label}")
        if not (-180 <= value[0] <= 180 and -90 <= value[1] <= 90):
            raise PackageError(f"coordinate outside longitude/latitude range for {label}")
        dimensions.add(len(value))

    def line(value, label):
        if not isinstance(value, list) or len(value) < 2:
            raise PackageError(f"line must contain at least two positions for {label}")
        for item in value:
            position(item, label)

    def ring(value, label):
        if not isinstance(value, list) or len(value) < 4:
            raise PackageError(f"polygon ring must contain at least four positions for {label}")
        for item in value:
            position(item, label)
        if value[0] != value[-1]:
            raise PackageError(f"polygon ring is not closed for {label}")

    if geometry_type == "LineString":
        line(coordinates, context)
    elif geometry_type == "MultiLineString":
        if not isinstance(coordinates, list) or not coordinates:
            raise PackageError(f"multiline geometry has no paths for {context}")
        for index, path in enumerate(coordinates):
            line(path, f"{context}/{index}")
    elif geometry_type == "Polygon":
        if not isinstance(coordinates, list) or not coordinates:
            raise PackageError(f"polygon has no rings for {context}")
        for index, boundary in enumerate(coordinates):
            ring(boundary, f"{context}/ring-{index}")
    elif geometry_type == "MultiPolygon":
        if not isinstance(coordinates, list) or not coordinates:
            raise PackageError(f"multipolygon has no parts for {context}")
        for polygon_index, polygon in enumerate(coordinates):
            if not isinstance(polygon, list) or not polygon:
                raise PackageError(f"multipolygon part has no rings for {context}/{polygon_index}")
            for ring_index, boundary in enumerate(polygon):
                ring(boundary, f"{context}/{polygon_index}/ring-{ring_index}")
    if len(dimensions) > 1:
        raise PackageError(f"inconsistent coordinate dimensions for {context}")
    return geometry


def required_property(properties, key, context):
    value = properties.get(key)
    if value is None or str(value) == "":
        raise PackageError(f"missing stable source field {key} for {context}")
    return value


def metadata_terms(metadata):
    result = {}
    for key in ("copyrightText", "accessInformation", "licenseInfo", "description"):
        value = metadata.get(key)
        if isinstance(value, str) and value.strip():
            result[key] = value
    return result


def layer_id_from_url(url):
    part = urlparse(url).path.rstrip("/").split("/")[-1]
    if not part.isdigit():
        raise PackageError(f"NHD source URL has no numeric layer ID: {url}")
    return int(part)


def build_package(snapshot_path, output_path, package_id, package_name, county_terms_path=None):
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", package_id):
        raise PackageError("package ID must be a lowercase hyphenated identifier")
    if not package_name.strip():
        raise PackageError("package name must not be empty")
    root, manifest, files, raw_snapshot_sha = verified_snapshot(pathlib.Path(snapshot_path))
    output = pathlib.Path(output_path).resolve()
    if output.exists():
        raise PackageError(f"refusing to overwrite existing package directory: {output}")

    for required in ("boundary.geojson", "roads.geojson", "water.geojson", "raw/boundary-metadata.json", "raw/roads-metadata.json", "raw/nhd-service-metadata.json"):
        if required not in files:
            raise PackageError(f"snapshot is missing required source artifact: {required}")
    sources = manifest.get("sources", {})
    core = sources.get("coreBoundary", {})
    roads = sources.get("roads", {})
    nhd = sources.get("nhdService", {})
    metadata_files = {
        "census": read_json(files["raw/boundary-metadata.json"]),
        "countyRoads": read_json(files["raw/roads-metadata.json"]),
        "usgsNhd": read_json(files["raw/nhd-service-metadata.json"]),
    }
    county_terms = metadata_terms(metadata_files["countyRoads"])
    if county_terms_path is not None:
        terms_path = pathlib.Path(county_terms_path).resolve(strict=True)
        terms_bytes = terms_path.read_bytes()
        try:
            item_metadata = json.loads(terms_bytes)
        except json.JSONDecodeError as exc:
            raise PackageError("County service item terms file is not valid JSON") from exc
        expected_item_id = metadata_files["countyRoads"].get("serviceItemId")
        if not expected_item_id or item_metadata.get("id") != expected_item_id:
            raise PackageError("County service item ID does not match road layer metadata")
        county_terms.update(metadata_terms(item_metadata))
        county_terms["serviceItemEvidence"] = {
            "url": f"https://www.arcgis.com/sharing/rest/content/items/{expected_item_id}?f=pjson",
            "rawFileSha256": hashlib.sha256(terms_bytes).hexdigest(),
        }
    if core.get("expectedFeatureCount") != 1 or core.get("retrievedFeatureCount") != 1:
        raise PackageError("core source count is not exactly one")
    if roads.get("expectedFeatureCount") != roads.get("retrievedFeatureCount"):
        raise PackageError("road source expected/retrieved counts differ")

    boundary = read_json(files["boundary.geojson"])
    road_collection = read_json(files["roads.geojson"])
    water_collection = read_json(files["water.geojson"])
    core_features = boundary.get("features")
    road_features = road_collection.get("features")
    water_features = water_collection.get("features")
    if not isinstance(core_features, list) or len(core_features) != 1:
        raise PackageError("boundary artifact must contain exactly one feature")
    if not isinstance(road_features, list) or len(road_features) != roads["retrievedFeatureCount"]:
        raise PackageError("road artifact count differs from verified source count")
    if not isinstance(water_features, list):
        raise PackageError("water artifact has no feature list")

    core_feature = core_features[0]
    core_props = core_feature.get("properties", {})
    geoid = str(required_property(core_props, "GEOID", "Census boundary"))
    source_name = str(required_property(core_props, "BASENAME", "Census boundary"))
    if source_name.casefold() != package_name.casefold():
        raise PackageError(f"Census boundary name mismatch: requested {package_name!r}, source has {source_name!r}")
    if core.get("requestedId") and str(core["requestedId"]) != geoid:
        raise PackageError("Census boundary GEOID differs from the requested stable ID")
    census_oid_field = core.get("objectIdField") or core.get("objectIdFieldName")
    if not census_oid_field:
        oid_fields = [field["name"] for field in metadata_files["census"].get("fields", [])
                      if field.get("type") == "esriFieldTypeOID"]
        if len(oid_fields) != 1:
            raise PackageError("Census metadata does not identify exactly one stable object ID field")
        census_oid_field = oid_fields[0]
    core_oid = required_property(core_props, census_oid_field, "Census boundary")
    core_geometry = checked_geometry(core_feature.get("geometry"), {"Polygon", "MultiPolygon"}, "Census boundary")
    core_id = f"census-cdp/{geoid}"
    features = [{"type": "Feature", "id": core_id, "geometry": core_geometry,
                 "properties": {"source": "U.S. Census Bureau", "name": source_name,
                                "sourceGeoId": geoid, "sourceObjectId": core_oid,
                                "coverageType": "Census designated place"}}]

    bindings = manifest.get("bindings", {})
    road_oid_field = bindings.get("roadObjectIdField")
    road_name_field = bindings.get("roadNameField")
    road_class_field = bindings.get("roadClassField")
    centerline_field = bindings.get("roadCenterlineIdField")
    road_classes = {"Local": "residential", "Collector": "tertiary", "Minor Arterial": "secondary", "Major Arterial": "primary", "Unknown": "unclassified"}
    for feature in road_features:
        props = feature.get("properties", {})
        oid = str(required_property(props, road_oid_field, "County road"))
        name = props.get(road_name_field)
        road_class = props.get(road_class_field)
        geometry = feature.get("geometry", {})
        if geometry.get("type") == "LineString":
            paths = [geometry.get("coordinates")]
        elif geometry.get("type") == "MultiLineString":
            paths = geometry.get("coordinates")
        else:
            raise PackageError(f"unsupported road geometry type: {geometry.get('type')}")
        if not isinstance(paths, list) or not paths:
            raise PackageError(f"road {oid} has no line paths")
        centerline = props.get(centerline_field) if centerline_field else None
        for part, coordinates in enumerate(paths):
            line = checked_geometry({"type": "LineString", "coordinates": coordinates}, {"LineString"}, f"County road {oid}/{part}")
            features.append({"type": "Feature", "id": f"pinellas-road/{oid}/{part}", "geometry": line,
                             "properties": {"source": "Pinellas County RoadCenterline",
                                            "sourceObjectId": props[road_oid_field],
                                            "sourceCenterlineId": centerline,
                                            "name": name,
                                            "sourceRoadClass": road_class,
                                            "highway": road_classes.get(road_class, "unclassified")}})

    nhd_layers = nhd.get("layers", {})
    if not isinstance(nhd_layers, dict):
        raise PackageError("NHD source layers are missing")
    layer_manifest = []
    water_ids = set()
    layer_roles = {"Area - Large Scale": "area", "Waterbody - Large Scale": "waterbody"}
    seen_roles = set()
    water_geojson_by_source_id = {str(feature.get("id", "")): feature for feature in water_features}
    for source_layer, layer in sorted(nhd_layers.items(), key=lambda pair: layer_id_from_url(pair[1].get("serviceUrl", ""))):
        role = layer_roles.get(source_layer)
        if role is None or role in seen_roles:
            raise PackageError(f"unexpected or duplicate NHD source role: {source_layer}")
        seen_roles.add(role)
        layer_url = layer.get("serviceUrl")
        layer_id = layer_id_from_url(layer_url or "")
        expected = layer.get("expectedFeatureCount")
        retrieved = layer.get("retrievedFeatureCount")
        if expected != retrieved or type(expected) is not int:
            raise PackageError(f"NHD counts differ or are invalid for {source_layer}")
        layer_features = layer.get("features")
        if not isinstance(layer_features, list) or len(layer_features) != retrieved:
            raise PackageError(f"NHD raw feature count differs for {source_layer}")
        layer_manifest.append({"role": role, "sourceLayer": source_layer, "layerId": layer_id, "serviceUrl": layer_url,
                               "metadataSha256": layer.get("metadataSha256"),
                               "expectedFeatureCount": expected, "retrievedFeatureCount": retrieved})
        for feature in layer_features:
            raw_attributes = feature.get("attributes", {})
            oid_field = layer.get("objectIdField")
            oid = required_property(raw_attributes, oid_field, f"USGS NHD {source_layer}")
            normalized = water_geojson_by_source_id.get(f"{source_layer}:{oid}")
            if not normalized:
                raise PackageError(f"normalized water feature is missing for {source_layer}:{oid}")
            props = normalized.get("properties", {})
            if str(props.get(oid_field)) != str(oid):
                raise PackageError(f"normalized water source ID differs for {source_layer}:{oid}")
            stable_id = f"usgs-nhd/{layer_id}/{oid}"
            if stable_id in water_ids:
                raise PackageError(f"duplicate NHD source ID: {stable_id}")
            water_ids.add(stable_id)
            geometry = checked_geometry(normalized.get("geometry"), {"Polygon", "MultiPolygon"}, stable_id)
            water_props = {"source": "USGS NHD", "sourceLayer": source_layer,
                           "sourceObjectId": oid}
            for input_key, output_key in (("PERMANENT_IDENTIFIER", "sourcePermanentIdentifier"),
                                          ("FDATE", "sourceFDate"), ("FTYPE", "sourceFType"),
                                          ("FCODE", "sourceFCode")):
                if input_key in props:
                    water_props[output_key] = props[input_key]
            name = props.get("GNIS_NAME")
            if name is not None and str(name).strip():
                water_props["name"] = name
            water_props["natural"] = "water"
            features.append({"type": "Feature", "id": stable_id, "geometry": geometry, "properties": water_props})
    if seen_roles != set(layer_roles.values()):
        raise PackageError("NHD snapshot must include both reviewed large-scale water roles")
    if len(water_features) != sum(item["retrievedFeatureCount"] for item in layer_manifest):
        raise PackageError("combined water count differs from the per-layer source counts")
    water_counts_by_id = {}
    for feature in water_features:
        source_layer = str(feature.get("id", "")).split(":", 1)[0]
        water_counts_by_id[source_layer] = water_counts_by_id.get(source_layer, 0) + 1
    for item in layer_manifest:
        if water_counts_by_id.get(item["sourceLayer"], 0) != item["retrievedFeatureCount"]:
            raise PackageError(f"water artifact count differs for {item['sourceLayer']}")

    all_ids = [feature["id"] for feature in features]
    if len(all_ids) != len(set(all_ids)):
        raise PackageError("packaged geographic feature IDs are not unique")
    geography = {"type": "FeatureCollection", "features": features}
    # Water features can contain hundreds of thousands of positions. Compact
    # JSON whitespace while retaining every coordinate and source attribute.
    geography_bytes = (json.dumps(geography, separators=(",", ":"), ensure_ascii=False, allow_nan=False) + "\n").encode()
    geography_sha = hashlib.sha256(geography_bytes).hexdigest()

    layer_metadata = {}
    for layer in layer_manifest:
        filename = f"raw/{layer['sourceLayer']}-metadata.json"
        if filename in files:
            layer_metadata[layer["sourceLayer"]] = metadata_terms(read_json(files[filename]))
    census_url = core.get("serviceUrl")
    road_url = roads.get("serviceUrl")
    nhd_url = nhd.get("serviceUrl")
    coverage_sources = list(dict.fromkeys([census_url, road_url, nhd_url, *[item["serviceUrl"] for item in layer_manifest]]))
    source_record = {
        "id": package_id,
        "name": package_name,
        "coverageKind": "census-designated-place",
        "coreFeatureId": core_id,
        "geographySha256": geography_sha,
        "acquiredAt": manifest.get("acquiredAt"),
        "rawSnapshotSha256": raw_snapshot_sha,
        "queryExtent": manifest.get("spatialQuery", {}).get("extent"),
        "sourceEvidence": {
            "censusCore": {"serviceUrl": census_url, "metadataSha256": core.get("metadataSha256"),
                           "expectedFeatureCount": core.get("expectedFeatureCount"),
                           "retrievedFeatureCount": core.get("retrievedFeatureCount"), "sourceGeoId": geoid},
            "countyRoads": {"serviceUrl": road_url, "metadataSha256": roads.get("metadataSha256"),
                            "expectedFeatureCount": roads.get("expectedFeatureCount"),
                            "retrievedFeatureCount": roads.get("retrievedFeatureCount"),
                            "packagedFeatureCount": sum(1 for feature in features if feature["id"].startswith("pinellas-road/"))},
            "usgsNhd": {"serviceUrl": nhd_url, "metadataSha256": nhd.get("metadataSha256"), "layers": layer_manifest},
        },
        "attribution": {"label": "Pinellas County GIS", "href": road_url},
        "additionalAttributions": [
            {"label": "U.S. Census Bureau (2026 Census Designated Places)", "href": census_url},
            {"label": "U.S. Geological Survey National Hydrography Dataset", "href": nhd_url},
        ],
        "license": None,
        "sourceNotices": {
            "coverageSources": coverage_sources,
            "license": None,
            "originalMetadata": {
                "census": metadata_terms(metadata_files["census"]),
                "countyRoads": county_terms,
                "usgsNhd": metadata_terms(metadata_files["usgsNhd"]),
                "nhdLayers": layer_metadata,
            },
        },
    }
    source_bytes = (json.dumps(source_record, indent=2, ensure_ascii=False, allow_nan=False) + "\n").encode()

    output.parent.mkdir(parents=True, exist_ok=True)
    staging = pathlib.Path(tempfile.mkdtemp(prefix=f".{output.name}-", dir=output.parent))
    try:
        (staging / "geography.geojson").write_bytes(geography_bytes)
        (staging / "source.json").write_bytes(source_bytes)
        os.rename(staging, output)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return geography, source_record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path, help="New package directory")
    parser.add_argument("--id", required=True, dest="package_id")
    parser.add_argument("--name", required=True, dest="package_name")
    parser.add_argument("--county-terms", type=pathlib.Path,
                        help="Optional public ArcGIS item JSON matching the road layer serviceItemId")
    args = parser.parse_args()
    try:
        _, source = build_package(args.snapshot, args.output, args.package_id, args.package_name, args.county_terms)
    except (PackageError, OSError, KeyError, TypeError, ValueError) as exc:
        print(f"county geography packaging failed: {exc}", file=sys.stderr)
        return 2
    print(f"packaged {source['sourceEvidence']['countyRoads']['packagedFeatureCount']} roads and "
          f"{sum(layer['retrievedFeatureCount'] for layer in source['sourceEvidence']['usgsNhd']['layers'])} NHD features to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
