#!/usr/bin/env python3
"""Render a review-only map from pinned, reusable geographic inputs.

This writes a scratch preview bundle, never the production catalog. The source
study and its limitations remain separate from accepted application coverage.
"""
import argparse
import hashlib
import html
import importlib.util
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True


def digest(data):
    return hashlib.sha256(data).hexdigest()


def render(study, output):
    study, output = study.resolve(), output.resolve()
    if output == ROOT or ROOT in output.parents or output.exists():
        raise ValueError("Use a new scratch output directory outside the repository")
    recipe = json.loads((study / "recipe.json").read_text())
    data = (study / "source-geometry.geojson").read_bytes()
    if digest(data) != recipe["sourceGeometrySha256"]:
        raise ValueError("Study source geometry checksum mismatch")
    source = json.loads(data)
    features = source["features"]
    core = [f for f in features if f.get("id") == recipe["coreFeatureId"]]
    if len(core) != 1:
        raise ValueError("Expected one pinned named area feature")
    core = core[0]
    if (core["properties"].get("name") != recipe["coreName"] or
            core["properties"].get("landuse") != recipe["coreLanduse"] or
            core["geometry"]["type"] != "Polygon" or len(core["geometry"]["coordinates"]) != 1):
        raise ValueError("Study identity or single-ring geometry differs from reviewed source")
    ring = core["geometry"]["coordinates"][0]
    if len(ring) < 4 or ring[0] != ring[-1]:
        raise ValueError("Study core must be a closed polygon ring")
    west, east = min(p[0] for p in ring), max(p[0] for p in ring)
    south, north = min(p[1] for p in ring), max(p[1] for p in ring)
    if east <= west or north <= south:
        raise ValueError("Study has no geographic extent")
    cosine = math.cos(math.radians((north + south) / 2))
    sy = min(760 / ((east - west) * cosine), 820 / (north - south))
    projection = dict(lngOrigin=(west + east) / 2, latOrigin=(north + south) / 2,
                      xOrigin=500, yOrigin=530, xScale=sy * cosine, yScale=sy)

    def xy(point):
        lng, lat = point[:2]
        return [round(500 + (lng - projection["lngOrigin"]) * projection["xScale"], 2),
                round(530 - (lat - projection["latOrigin"]) * projection["yScale"], 2)]

    def path(points, close=False):
        return "M" + "L".join(",".join(map(str, xy(p))) for p in points) + ("Z" if close else "")

    roads = [f for f in features if f["geometry"]["type"] in ["LineString", "MultiLineString"]
             and f["properties"].get("highway") in
             ["residential", "service", "tertiary", "secondary", "primary", "unclassified", "living_street"]]
    road_paths = [(f, line) for f in roads for line in
                  ([f["geometry"]["coordinates"]] if f["geometry"]["type"] == "LineString" else f["geometry"]["coordinates"])]
    art = ['<rect x="20" y="20" width="960" height="1020" fill="#dedbc0"/>']
    polygons = [f for f in features if f["geometry"]["type"] in ["Polygon", "MultiPolygon"]]
    polygons.sort(key=lambda f: bool(f["properties"].get("natural") == "water" or f["properties"].get("water")))
    for f in polygons:
        props = f["properties"]
        water = props.get("natural") == "water" or props.get("water")
        park = props.get("leisure") in ["park", "garden", "nature_reserve"]
        if not water and not park:
            continue
        rings = f["geometry"]["coordinates"] if f["geometry"]["type"] == "Polygon" else [r for p in f["geometry"]["coordinates"] for r in p]
        geometry = "".join(path(r, True) for r in rings)
        art.append(f'<path d="{geometry}" fill-rule="evenodd" fill="{"#c6bfd1" if water else "#b9c3a1"}" stroke="{"#938bae" if water else "#8e987a"}" stroke-width="1.3"/>')
    for color, width in [("#998692", 10), ("#f8efd9", 7.5)]:
        art.append(f'<g fill="none" stroke="{color}" stroke-width="{width}" stroke-linecap="round" stroke-linejoin="round">')
        art.extend(f'<path d="{path(line)}"/>' for _, line in road_paths)
        art.append("</g>")
    candidates = []
    for f, line in road_paths:
        name = f["properties"].get("name")
        if not name:
            continue
        for a, b in zip(line, line[1:]):
            pa, pb = xy(a), xy(b)
            length = math.dist(pa, pb)
            x, y = (pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2
            if length > 12 and 90 < x < 910 and 90 < y < 970:
                candidates.append((length, name, x, y, math.degrees(math.atan2(pb[1] - pa[1], pb[0] - pa[0]))))
    placed, names = [], set()
    for _, name, x, y, angle in sorted(candidates, reverse=True):
        if name in names or len(placed) >= 18 or any(math.hypot(x - a, y - b) < 110 for a, b in placed):
            continue
        angle = angle - 180 if angle > 90 else angle + 180 if angle < -90 else angle
        art.append(f'<text transform="translate({x:.2f} {y:.2f}) rotate({angle:.2f})" text-anchor="middle" font-family="Georgia,serif" font-size="11.2" fill="#695572" stroke="#f2e9d3" stroke-width="3" paint-order="stroke">{html.escape(name)}</text>')
        placed.append((x, y)); names.add(name)
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="20 20 960 1020"><defs>'
           f'<mask id="spotlight"><path d="{path(ring, True)}" fill="white"/></mask>'
           '<g id="geographyArtwork">' + "".join(art) + '</g></defs>'
           '<rect x="20" y="20" width="960" height="1020" fill="#f6efdd"/>'
           '<use href="#geographyArtwork" opacity=".2"/>'
           '<use href="#geographyArtwork" mask="url(#spotlight)"/></svg>').encode()
    spec = importlib.util.spec_from_file_location("geography_import", ROOT / "scripts/import-ftw-geography.py")
    importer = importlib.util.module_from_spec(spec); spec.loader.exec_module(importer)
    bounds = dict(left=20, right=980, top=20, bottom=1040)
    anchors = importer.anchors_for({"features": roads}, projection, bounds, svg, recipe["id"])
    if len(anchors) != 4:
        raise ValueError("Study needs four independently matched road vertices")
    config = dict(id=recipe["id"], name=recipe["name"], width=1000, height=1060,
                  bounds=bounds, projection=projection,
                  artwork=f'./assets/neighborhoods/{recipe["id"]}.svg',
                  rasterArtwork=f'./assets/neighborhoods/{recipe["id"]}.webp',
                  coreBoundary=[xy(p) for p in ring], overviewBounds=importer.overview_bounds(ring, projection),
                  attribution={"label": "© OpenStreetMap contributors", "href": "https://www.openstreetmap.org/copyright"},
                  license=source["license"], licenseUrl=source["licenseUrl"],
                  sourceNotices=f'./data/{recipe["id"]}/source-notices.json', studyStatus=recipe["status"])
    provenance = dict(status=recipe["status"], acceptedForCatalog=False,
                      sourceGeometrySha256=digest(data), recipeSha256=digest((study / "recipe.json").read_bytes()),
                      rendererSha256=digest(Path(__file__).read_bytes()),
                      sourceRepository=recipe["sourceRepository"], sourceRevision=recipe["sourceRevision"],
                      sourceFiles=recipe["sourceFiles"], coreFeatureId=recipe["coreFeatureId"],
                      knownLimitations=recipe["knownLimitations"], roadFeatures=len(roads), overviewLabels=len(placed))
    directory = output / "public/data" / recipe["id"]
    directory.mkdir(parents=True)
    artwork = output / "public/assets/neighborhoods"; artwork.mkdir(parents=True)
    (artwork / (recipe["id"] + ".svg")).write_bytes(svg)
    for filename, value in [("neighborhood.json", config), ("anchors.json", anchors), ("provenance.json", provenance),
                            ("source-notices.json", {"attribution": source["attribution"], "license": source["license"],
                             "licenseUrl": source["licenseUrl"], "coverageKind": recipe["coverageKind"],
                             "coreFeatureUrl": "https://www.openstreetmap.org/" + recipe["coreFeatureId"],
                             "knownLimitations": recipe["knownLimitations"]})]:
        (directory / filename).write_text(json.dumps(value, indent=2) + "\n")
    (directory / "source-geometry.geojson").write_bytes(data)
    catalog = [{"id": recipe["id"], "name": recipe["name"], "config": f'./data/{recipe["id"]}/neighborhood.json', "pins": []}]
    (output / "public/neighborhood-catalog.mjs").write_text("export const importedNeighborhoods = " + json.dumps(catalog) + ";\n")
    print(json.dumps({"id": recipe["id"], "status": recipe["status"], "anchors": len(anchors), "roadFeatures": len(roads), "labels": len(placed), "output": str(output)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--study", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    render(args.study, args.output)
