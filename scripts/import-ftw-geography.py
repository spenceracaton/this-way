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
import sys
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
        if props.get("osmType") != "way" or props.get("highway") in {None, "footway", "path", "steps"}:
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
                candidates.append((distance, str(props.get("osmId", feature.get("id", "way"))), index, coord, match))
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


def run(source: Path, reference: Path):
    maps = load_json(reference / "neighborhood-maps.json")
    buffers = load_json(reference / "neighborhood-buffer-config.json")
    source_manifest = load_json(source / "manifest.json")
    existing = {"old-northeast", "crescent-lake"}
    ids = sorted(set(maps) - existing, key=lambda value: (maps[value]["name"].casefold(), value))
    if len(ids) != 57:
        raise ValueError(f"Expected 57 new fixed neighborhoods, found {len(ids)}")
    file_manifest = {(item["id"], item["file"]): item for item in source_manifest.get("files", [])}
    for neighborhood_id in ids:
        folder = source / neighborhood_id
        source_svg, data_path, buffer_path = folder / "review-map.svg", folder / "map-data.json", folder / "buffer.mjs"
        missing = [p for p in (source_svg, data_path, buffer_path) if not p.is_file()]
        if missing:
            raise FileNotFoundError(f"Missing source files for {neighborhood_id}: {missing}")
        metadata = maps[neighborhood_id]
        buffer_config = buffers[neighborhood_id]
        map_data = load_json(data_path)
        buffer, buffer_payload_path = buffer_data(buffer_path)
        svg = clean_geography_svg(source_svg, buffer, buffer_config["bufferBounds"], metadata["bounds"])
        svg_path = ROOT / "public/assets/neighborhoods" / f"{neighborhood_id}.svg"
        config_path = ROOT / "public/data" / neighborhood_id
        svg_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.mkdir(parents=True, exist_ok=True)
        svg_path.write_bytes(svg)
        attribution_label = map_data.get("attribution") or "Map data attribution unavailable"
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
        (config_path / "neighborhood.json").write_text(json.dumps(config, indent=2) + "\n")
        anchors = anchors_for(map_data, metadata["projection"], metadata["bounds"], svg, neighborhood_id)
        (config_path / "anchors.json").write_text(json.dumps(anchors, indent=2) + "\n")
        source_hashes = {name: hashlib.sha256(path.read_bytes()).hexdigest()
                         for name, path in (("review-map.svg", source_svg), ("map-data.json", data_path), ("buffer.mjs", buffer_path))}
        if buffer_payload_path != buffer_path:
            source_hashes[buffer_payload_path.name] = hashlib.sha256(buffer_payload_path.read_bytes()).hexdigest()
        for name, digest in source_hashes.items():
            expected = file_manifest.get((neighborhood_id, name))
            if not expected or expected.get("sha256") != digest:
                raise ValueError(f"Source checksum mismatch: {neighborhood_id}/{name}")
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
            "sourceGeoAttribution": {"originalCredit": attribution_label, "attribution": config["attribution"], "additionalAttributions": config.get("additionalAttributions", []), "license": config["license"], "licenseUrl": config["licenseUrl"]},
            "boundaryNote": "Approximate app coverage; not a legal boundary.",
            "anchors": len(anchors)}
        provenance_path = config_path / "provenance.json"
        if provenance_path.exists():
            prior = load_json(provenance_path)
            raster = prior.get("rasterArtwork", {})
            if raster.get("sourceSha256") == hashlib.sha256(svg).hexdigest():
                provenance["rasterArtwork"] = raster
        provenance_path.write_text(json.dumps(provenance, indent=2) + "\n")

    catalog = [{"id": item, "name": maps[item]["name"], "config": f"./data/{item}/neighborhood.json", "pins": []} for item in ids]
    (ROOT / "public/neighborhood-catalog.mjs").write_text("// Fixed-neighborhood geography only; FTW database-only areas are not included.\nexport const importedNeighborhoods = " + json.dumps(catalog, indent=2, ensure_ascii=False) + ";\n")
    (ROOT / "public/data/neighborhood-import.json").write_text(json.dumps({
        "sourceRepository": source_manifest["repository"], "sourceRevision": source_manifest["revision"],
        "supportedIds": sorted(["old-northeast", *maps]),
        "retainedSampleMaps": ["old-northeast", "crescent-lake"], "importedIds": sorted(ids),
        "listingRecordsImported": 0, "seasonalOverlaysImported": 0,
        "metadataSha256": hashlib.sha256((reference / "neighborhood-maps.json").read_bytes()).hexdigest(),
        "bufferConfigSha256": hashlib.sha256((reference / "neighborhood-buffer-config.json").read_bytes()).hexdigest(),
        "scope": "Fixed source-reviewed registry; FTW database-only areas are excluded."
    }, indent=2) + "\n")
    print(f"Imported {len(ids)} fixed neighborhood maps.")
    for item in ids:
        anchors = load_json(ROOT / "public/data" / item / "anchors.json")
        if len(anchors) < 3:
            print(f"ANCHOR REVIEW: {item} has {len(anchors)} matched road anchors", file=sys.stderr)


def root_view_box(source_svg: Path) -> str:
    return ET.parse(source_svg).getroot().get("viewBox", "")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=SOURCE, help="Offline source bundle directory")
    parser.add_argument("--reference", type=Path, default=REFERENCE, help="Prepared reference directory")
    options = parser.parse_args()
    run(options.source.resolve(), options.reference.resolve())
