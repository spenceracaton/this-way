#!/usr/bin/env python3
"""Import the fixed ThisWay geography from the offline FTW QA bundle.

The output deliberately contains geography only. No listing or house records
are read or copied. Run from any directory; paths are resolved from this file.
"""

from __future__ import annotations

import hashlib
import argparse
import json
import math
import re
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parent
SOURCE = WORKSPACE / "design-review/ftw-map-source"
REFERENCE = WORKSPACE / "design-review/ftw-reference"
SVG_NS = "http://www.w3.org/2000/svg"
XLINK_NS = "http://www.w3.org/1999/xlink"
ET.register_namespace("", SVG_NS)
ET.register_namespace("xlink", XLINK_NS)


def tag(name: str) -> str:
    return f"{{{SVG_NS}}}{name}"


def load_json(path: Path):
    return json.loads(path.read_text())


def buffer_data(path: Path):
    source = path.read_text().strip()
    prefix = "export default "
    if source.startswith(prefix):
        return json.loads(source[len(prefix):].rstrip().removesuffix(";")), path
    # Some reviewed runtime modules are thin wrappers around the pinned JSON
    # payload. Resolve only that exact local JSON reference.
    match = re.fullmatch(r"// Runtime wrapper; the reviewed JSON file is the single source of truth\.\s*export \{default\} from ['\"]\./([^'\"]+\.json)['\"] with \{type:'json'\};?", source)
    if match:
        payload = path.parent / match.group(1)
        if payload.is_file():
            return json.loads(payload.read_text()), payload
    raise ValueError(f"Unexpected buffer module or missing pinned JSON payload: {path}")


def clean_geography_svg(source_svg: Path, buffer_json: dict, bounds: dict, core_bounds: dict) -> bytes:
    root = ET.parse(source_svg).getroot()
    source_viewbox = [float(value) for value in root.get("viewBox", "").split()]
    if len(source_viewbox) != 4 or source_viewbox[2] <= 0 or source_viewbox[3] <= 0:
        raise ValueError(f"Invalid source SVG viewBox in {source_svg}: {root.get('viewBox')}")
    sx, sy, sw, sh = source_viewbox
    if (core_bounds["left"] < sx or core_bounds["top"] < sy or
            core_bounds["right"] > sx + sw or core_bounds["bottom"] > sy + sh):
        raise ValueError(f"Source viewBox does not contain prepared core extent: {source_svg}")
    root.set("viewBox", f"{bounds['left']} {bounds['top']} {bounds['right']-bounds['left']} {bounds['bottom']-bounds['top']}")
    defs = root.find(tag("defs"))
    if defs is None:
        raise ValueError(f"Missing SVG defs in {source_svg}")
    geography = next((e for e in defs if e.get("id") == "geographyArtwork"), None)
    core_mask = next((e for e in defs if e.get("id") == "spotlight"), None)
    if geography is None or core_mask is None:
        raise ValueError(f"Missing geography artwork or core mask in {source_svg}")

    # Keep the source paths and core mask exactly intact. Remove decorative
    # presentation resources and blur references for neutral map artwork.
    for node in list(defs):
        if node.tag in (tag("pattern"), tag("filter")):
            defs.remove(node)
    for node in root.iter():
        node.attrib.pop("filter", None)
        node.attrib.pop("onload", None)
        for attribute in list(node.attrib):
            if attribute.lower().startswith("on"):
                del node.attrib[attribute]
            elif "url(#water)" in node.attrib[attribute]:
                # Keep the source water polygon geometry while replacing its
                # decorative repeating pattern with a neutral solid fill.
                node.attrib[attribute] = node.attrib[attribute].replace("url(#water)", "#dce4e2")

    buffer_nodes = ET.fromstring(f'<svg xmlns="{SVG_NS}">{buffer_json["artwork"]}</svg>')
    nearby_mask = next((e for e in buffer_nodes if e.get("id") == "nearbyBlocksMask"), None)
    nearby_art = next((e for e in buffer_nodes if e.get("id") == "nearbyBlocksArtwork"), None)
    if nearby_mask is None or nearby_art is None:
        raise ValueError("Buffer artwork must contain nearbyBlocksMask and nearbyBlocksArtwork")
    defs.append(nearby_mask)
    defs.append(nearby_art)

    # Water texture overlays are omitted in the neutral renderer, as on the two
    # original prototype maps. Keep their geometry but remove the dead paint ref.
    for node in root.iter():
        if node.get('fill') in {'url(#water)', 'url(#paper)'}:
            node.set('fill', 'none')

    # Defensively reject anything executable or embedding/routing externally.
    for node in root.iter():
        local = node.tag.split("}")[-1].lower()
        if local in {"script", "foreignobject", "image", "symbol", "textpath"}:
            raise ValueError(f"Unsafe or non-geographic SVG element: {local}")
        element_id = node.get("id", "").lower()
        if any(word in element_id for word in ("season", "pumpkin", "ghost", "house", "event", "invite", "decoration")):
            raise ValueError(f"Seasonal or listing element found in SVG: {element_id}")
        for attribute, value in node.attrib.items():
            key = attribute.split("}")[-1].lower()
            if key.startswith("on"):
                raise ValueError("SVG event handler survived sanitization")
            if key in {"href", "src"} and value and not value.startswith("#"):
                raise ValueError(f"External SVG reference is not allowed: {value}")

    # Replace root children with a simple neutral layer stack. The source
    # artwork and mask paths remain in defs byte-for-byte at the path-data level.
    for child in list(root):
        if child is not defs:
            root.remove(child)
    left, right, top, bottom = bounds["left"], bounds["right"], bounds["top"], bounds["bottom"]
    ET.SubElement(root, tag("rect"), {"x": str(left), "y": str(top),
        "width": str(right-left), "height": str(bottom-top), "fill": "#f6efdd"})
    ET.SubElement(root, tag("use"), {"href": "#geographyArtwork", "opacity": ".2"})
    ET.SubElement(root, tag("use"), {"href": "#nearbyBlocksArtwork", "mask": "url(#nearbyBlocksMask)"})
    ET.SubElement(root, tag("use"), {"href": "#geographyArtwork", "mask": "url(#spotlight)"})
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def project(projection: dict, coordinate: list[float]) -> tuple[float, float]:
    lng, lat = coordinate
    return (projection["xOrigin"] + (lng - projection["lngOrigin"]) * projection["xScale"],
            projection["yOrigin"] - (lat - projection["latOrigin"]) * projection["yScale"])


def overview_bounds(points: list[list[float]], projection: dict) -> dict:
    projected = [project(projection, point) for point in points]
    return {"left": min(p[0] for p in projected), "right": max(p[0] for p in projected),
            "top": min(p[1] for p in projected), "bottom": max(p[1] for p in projected)}


def svg_vertices(svg_bytes: bytes) -> list[tuple[float, float]]:
    root = ET.fromstring(svg_bytes)
    result = []
    number = r"[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?"
    for node in root.iter(tag("path")):
        d = node.get("d", "")
        for x, y in re.findall(rf"[MLml]\s*({number})[,\s]+({number})", d):
            result.append((float(x), float(y)))
    return result


def anchors_for(map_data: dict, projection: dict, bounds: dict, svg: bytes, neighborhood_id: str) -> list[dict]:
    vertices = svg_vertices(svg)
    grid: dict[tuple[int, int], list[tuple[float, float]]] = {}
    for vertex in vertices:
        grid.setdefault((math.floor(vertex[0] * 10), math.floor(vertex[1] * 10)), []).append(vertex)
    candidates = []
    for feature in map_data.get("features", []):
        props = feature.get("properties", {})
        source_way = re.fullmatch(r"way/(\d+)", str(feature.get("id", "")))
        if not (props.get("osmType") == "way" or source_way) or props.get("highway") in {None, "footway", "path", "steps"}:
            continue
        coords = feature.get("geometry", {}).get("coordinates", [])
        if feature.get("geometry", {}).get("type") != "LineString":
            continue
        for index, coord in enumerate(coords):
            xy = project(projection, coord)
            if not (bounds["left"] <= xy[0] <= bounds["right"] and bounds["top"] <= xy[1] <= bounds["bottom"]):
                continue
            if not vertices:
                continue
            cell = (math.floor(xy[0] * 10), math.floor(xy[1] * 10))
            nearby = [vertex for gx in range(cell[0]-1, cell[0]+2) for gy in range(cell[1]-1, cell[1]+2)
                      for vertex in grid.get((gx, gy), [])]
            if not nearby:
                continue
            match = min(nearby, key=lambda v: math.hypot(v[0]-xy[0], v[1]-xy[1]))
            distance = math.hypot(match[0]-xy[0], match[1]-xy[1])
            if distance <= .1:
                osm_id = props.get("osmId") or (source_way.group(1) if source_way else None)
                if osm_id is None:
                    continue
                candidates.append((distance, str(osm_id), index, coord, match))
    # Select geographically separated matches; no computed-only anchors are emitted.
    selected = []
    for item in sorted(candidates):
        if all(math.hypot(item[4][0]-old[4][0], item[4][1]-old[4][1]) > 100 for old in selected):
            selected.append(item)
        if len(selected) == 4:
            break
    return [{"id": f"{neighborhood_id}-road-{i+1}", "osmType": "way", "osmId": item[1],
             "sourceGeographic": {"lng": item[3][0], "lat": item[3][1]},
             "expectedSourcePoint": [round(item[4][0], 6), round(item[4][1], 6)],
             "matchErrorPx": round(item[0], 6)} for i, item in enumerate(selected)]


def source_notices(data: dict, metadata: dict) -> dict:
    """Retain declared terms without applying one source's license to another."""
    keys = ("attribution", "license", "licenseUrl", "sourceUrl", "sourceLicenses",
            "licenses", "sourceBindings", "supplementalOriginalTraceLicense", "coverageDerivation")
    notices = {key: data[key] for key in keys if key in data}
    notices["coverageSources"] = metadata.get("coverageSources", [])
    # Keep the distinct source/terms records attached to authored geography,
    # without duplicating all road coordinates or any unrelated app data.
    distinct = {}
    for feature in data.get("features", []):
        props = feature.get("properties", {})
        record = {key: value for key, value in props.items()
                  if re.search(r"source|licens|attribut|copyright|terms", key, re.I)}
        if record:
            distinct[json.dumps(record, sort_keys=True)] = record
    notices["featureNotices"] = list(distinct.values())
    return notices


def reviewed_credits(notices: dict, map_data: dict) -> tuple[dict, list[dict]]:
    text = json.dumps(notices, ensure_ascii=False).lower()
    has_osm = "openstreetmap" in text or any(
        feature.get("properties", {}).get("osmType") in {"way", "node", "relation"}
        for feature in map_data.get("features", []))
    if not has_osm:
        raise ValueError("Unrecognized geography source; review attribution before importing")
    primary = {"label": "© OpenStreetMap contributors", "href": "https://www.openstreetmap.org/copyright"}
    additional = []
    # This normalization is used only for the newly reviewed batches. Earlier
    # maps keep their existing presentation. Exact wording/terms stay in the
    # downloadable source notices, including missing/unspecified license fields.
    city = next((url for url in notices["coverageSources"] if "egis.stpete.org" in url), None)
    if city:
        additional.append({"label": "City of St. Petersburg GIS", "href": city})
    if any(word in text for word in ("pinellas", "county2026", "county2025", "county-aerial", "county/esri")):
        label = "Pinellas County imagery" + (" / Esri" if "esri" in text or "arcgisonline" in text else "")
        urls = re.findall(r'https://[^\s"<>]+', json.dumps(notices))
        url = next((value for value in urls if "egis.pinellas.gov" in value), None)
        url = url or next((value for value in urls if "services.arcgisonline.com" in value), None)
        additional.append({"label": label, **({"href": url} if url else {})})
    return primary, additional


def run(source: Path, reference: Path, selected: list[str] | None = None, output: Path = ROOT):
    maps = load_json(reference / "neighborhood-maps.json")
    buffers = load_json(reference / "neighborhood-buffer-config.json")
    source_manifest = load_json(source / "manifest.json")
    for filename, record in source_manifest.get("referenceFiles", {}).items():
        if filename not in {"neighborhood-maps.json", "neighborhood-buffer-config.json"}:
            continue
        if hashlib.sha256((reference / filename).read_bytes()).hexdigest() != record["sha256"]:
            raise ValueError(f"Reference checksum mismatch: {filename}")
    existing = {"old-northeast", "crescent-lake"}
    requested = set(selected) if selected is not None else set(maps) - existing
    if not requested or requested - set(maps) or requested & existing:
        raise ValueError("Select nonempty prepared map IDs; sample maps cannot be replaced")
    if any(not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", item) for item in requested):
        raise ValueError("Invalid neighborhood ID")
    ids = sorted(requested, key=lambda value: (maps[value]["name"].casefold(), value))
    file_manifest = {(item["id"], item["file"]): item for item in source_manifest.get("files", [])}
    # Prepare and validate the entire batch before touching any output. A bad
    # source in the last map must not partially publish the earlier maps.
    writes = {}
    for neighborhood_id in ids:
        folder = source / neighborhood_id
        source_svg, data_path, buffer_path = folder / "review-map.svg", folder / "map-data.json", folder / "buffer.mjs"
        missing = [p for p in (source_svg, data_path, buffer_path) if not p.is_file()]
        if missing:
            raise FileNotFoundError(f"Missing source files for {neighborhood_id}: {missing}")
        verified_hashes = {}
        for (item_id, name), record in file_manifest.items():
            if item_id != neighborhood_id:
                continue
            if Path(name).name != name:
                raise ValueError(f"Invalid manifest filename: {name}")
            digest = hashlib.sha256((folder / name).read_bytes()).hexdigest()
            if record.get("sha256") != digest:
                raise ValueError(f"Source checksum mismatch: {neighborhood_id}/{name}")
            verified_hashes[name] = digest
        metadata = maps[neighborhood_id]
        buffer_config = buffers[neighborhood_id]
        projection = metadata["projection"]
        if not all(isinstance(value, (float, int)) and math.isfinite(value) for value in projection.values()):
            raise ValueError(f"Invalid projection: {neighborhood_id}")
        if projection["xScale"] <= 0 or projection["yScale"] <= 0:
            raise ValueError(f"Invalid projection scales: {neighborhood_id}")
        map_data = load_json(data_path)
        buffer, buffer_payload_path = buffer_data(buffer_path)
        svg = clean_geography_svg(source_svg, buffer, buffer_config["bufferBounds"], metadata["bounds"])
        svg_path = output / "public/assets/neighborhoods" / f"{neighborhood_id}.svg"
        config_path = output / "public/data" / neighborhood_id
        writes[svg_path] = svg
        attribution_label = map_data.get("attribution") or "Map data attribution unavailable"
        is_expansion = source_manifest.get("normalizedSourceNotices", False)
        if not is_expansion and (not map_data.get("attribution") or not map_data.get("license")):
            raise ValueError(f"Missing geography source credit/license: {neighborhood_id}")
        attribution = {"label": attribution_label}
        if "aerials2026" in attribution_label.lower():
            county_source = next((url for url in metadata.get("coverageSources", [])
                                  if isinstance(url, str) and "egis.pinellas.gov" in url and "Aerials2026" in url), None)
            if county_source:
                attribution["href"] = county_source
        elif "openstreetmap" in attribution_label.lower():
            attribution["href"] = "https://www.openstreetmap.org/copyright"
        config = {"id": neighborhood_id, "name": metadata["name"], "width": 1000, "height": 1060,
            "bounds": buffer_config["bufferBounds"], "projection": metadata["projection"],
            "artwork": f"./assets/neighborhoods/{neighborhood_id}.svg",
            "rasterArtwork": f"./assets/neighborhoods/{neighborhood_id}.webp",
            "coreBoundary": [list(project(metadata["projection"], point)) for point in buffer_config["coreCoverage"]],
            "overviewBounds": overview_bounds(buffer_config["coreCoverage"], metadata["projection"]),
            "attribution": attribution,
            "license": map_data.get("license", "ODbL-1.0"), "licenseUrl": map_data.get("licenseUrl")}
        if attribution_label.startswith("© OpenStreetMap contributors;"):
            config["attribution"] = {"label": "© OpenStreetMap contributors", "href": "https://www.openstreetmap.org/copyright"}
            config["additionalAttributions"] = [{"label": attribution_label.split(";", 1)[1].strip(), **({"href": attribution["href"]} if attribution.get("href") else {})}]
        if is_expansion:
            notices = source_notices(map_data, metadata)
            for filename in ["buffer-map-data.json", "source-geography.geojson"]:
                if filename in verified_hashes:
                    notices[filename] = source_notices(load_json(folder / filename), metadata)
            config["attribution"], config["additionalAttributions"] = reviewed_credits(notices, map_data)
            config["license"] = map_data.get("license")
            config["sourceNotices"] = f"./data/{neighborhood_id}/source-notices.json"
            writes[config_path / "source-notices.json"] = (json.dumps(notices, indent=2, ensure_ascii=False) + "\n").encode()
        writes[config_path / "neighborhood.json"] = (json.dumps(config, indent=2) + "\n").encode()
        anchors = anchors_for(map_data, metadata["projection"], metadata["bounds"], svg, neighborhood_id)
        if len(anchors) != 4:
            raise ValueError(f"Expected four independently matched road anchors: {neighborhood_id}, found {len(anchors)}")
        writes[config_path / "anchors.json"] = (json.dumps(anchors, indent=2) + "\n").encode()
        source_hashes = {name: hashlib.sha256(path.read_bytes()).hexdigest()
                         for name, path in (("review-map.svg", source_svg), ("map-data.json", data_path), ("buffer.mjs", buffer_path))}
        if buffer_payload_path != buffer_path:
            source_hashes[buffer_payload_path.name] = hashlib.sha256(buffer_payload_path.read_bytes()).hexdigest()
        for name, digest in source_hashes.items():
            expected = file_manifest.get((neighborhood_id, name))
            if not expected or expected.get("sha256") != digest:
                raise ValueError(f"Source checksum mismatch: {neighborhood_id}/{name}")
        source_hashes.update(verified_hashes)
        original_mask = ET.parse(source_svg).getroot().find(f".//{tag('mask')}[@id='spotlight']")
        mask_d = "\n".join(node.get("d", "") for node in original_mask.iter(tag("path")))
        nearby_root = ET.fromstring(f'<svg xmlns="{SVG_NS}">{buffer["artwork"]}</svg>')
        nearby_mask = nearby_root.find(f".//{tag('mask')}[@id='nearbyBlocksMask']")
        nearby_d = "\n".join(node.get("d", "") for node in nearby_mask.iter(tag("path")))
        provenance = {"id": neighborhood_id, "sourceRepository": source_manifest.get("repository"),
            "sourceRevision": source_manifest.get("revision"), "sourceFiles": source_hashes,
            "sourceManifestRevision": source_manifest.get("revision"),
            "sourceViewBox": root_view_box(source_svg), "finalViewBox": f"{buffer_config['bufferBounds']['left']} {buffer_config['bufferBounds']['top']} {buffer_config['bufferBounds']['right']-buffer_config['bufferBounds']['left']} {buffer_config['bufferBounds']['bottom']-buffer_config['bufferBounds']['top']}",
            "coreMaskGeometrySha256": hashlib.sha256(mask_d.encode()).hexdigest(),
            "nearbyMaskGeometrySha256": hashlib.sha256(nearby_d.encode()).hexdigest(),
            "transformNotes": "Source SVG coordinates and core/nearby mask paths are preserved. Projection comes from the prepared fixed-neighborhood metadata; bounds come from the configured buffer viewBox. Overview bounds project the core coverage coordinates.",
            "sourceGeoAttribution": {"originalCredit": map_data.get("attribution"), "attribution": config["attribution"], "additionalAttributions": config.get("additionalAttributions", []), "license": config["license"], "licenseUrl": config["licenseUrl"]},
            "boundaryNote": "Approximate app coverage; not a legal boundary.",
            "anchors": len(anchors)}
        provenance["sourcePaths"] = {name: file_manifest[(neighborhood_id, name)]["sourcePath"] for name in source_hashes}
        if is_expansion:
            provenance["sourceNoticesSha256"] = hashlib.sha256(writes[config_path / "source-notices.json"]).hexdigest()
        provenance_path = config_path / "provenance.json"
        if provenance_path.exists():
            prior = load_json(provenance_path)
            raster = prior.get("rasterArtwork", {})
            if raster.get("sourceSha256") == hashlib.sha256(svg).hexdigest():
                provenance["rasterArtwork"] = raster
        writes[provenance_path] = (json.dumps(provenance, indent=2) + "\n").encode()

    summary_path = output / "public/data/neighborhood-import.json"
    prior_summary = load_json(summary_path) if summary_path.exists() else {}
    all_ids = sorted(set(prior_summary.get("importedIds", [])) | set(ids))
    catalog = []
    for item in all_ids:
        path = output / "public/data" / item / "neighborhood.json"
        config = json.loads(writes[path]) if path in writes else load_json(path)
        catalog.append({"id": item, "name": config["name"], "config": f"./data/{item}/neighborhood.json", "pins": []})
    catalog.sort(key=lambda item: (item["name"].casefold(), item["id"]))
    catalog_path = output / "public/neighborhood-catalog.mjs"
    writes[catalog_path] = ("// Prepared geography only; directory names without maps are excluded.\nexport const importedNeighborhoods = " + json.dumps(catalog, indent=2, ensure_ascii=False) + ";\n").encode()
    batch = {
        "sourceRepository": source_manifest["repository"], "sourceRevision": source_manifest["revision"],
        "importedIds": sorted(ids),
        "metadataSha256": hashlib.sha256((reference / "neighborhood-maps.json").read_bytes()).hexdigest(),
        "bufferConfigSha256": hashlib.sha256((reference / "neighborhood-buffer-config.json").read_bytes()).hexdigest(),
    }
    batches = prior_summary.get("batches", [])
    if not batches and prior_summary:
        batches = [{key: prior_summary[key] for key in batch if key in prior_summary}]
    batches = [item for item in batches if item != batch] + [batch]
    summary = {"sourceRepository": source_manifest["repository"], "sourceRevision": source_manifest["revision"],
        "supportedIds": sorted(existing | set(all_ids)), "retainedSampleMaps": sorted(existing),
        "importedIds": all_ids, "listingRecordsImported": 0, "seasonalOverlaysImported": 0,
        "batches": batches, "scope": "Prepared maps recovered from pinned QA inputs; directory-only areas are excluded."}
    # Keep the retained sample ordering stable for consumers of this manifest.
    summary["retainedSampleMaps"] = ["old-northeast", "crescent-lake"]
    writes[summary_path] = (json.dumps(summary, indent=2) + "\n").encode()
    for path, payload in writes.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
    print(f"Imported {len(ids)} fixed neighborhood maps.")


def root_view_box(source_svg: Path) -> str:
    return ET.parse(source_svg).getroot().get("viewBox", "")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=SOURCE, help="Offline source bundle directory")
    parser.add_argument("--reference", type=Path, default=REFERENCE, help="Prepared reference directory")
    parser.add_argument("--ids", nargs="+", help="Import only these map IDs, preserving the rest of the catalog")
    parser.add_argument("--output-root", type=Path, default=ROOT, help="Output tree (use a scratch directory for preflight)")
    options = parser.parse_args()
    run(options.source.resolve(), options.reference.resolve(), options.ids, options.output_root.resolve())
