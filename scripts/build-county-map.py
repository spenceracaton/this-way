#!/usr/bin/env python3
"""Build one neutral map bundle from a checksum-pinned geographic package.

Source packaging and map registration are separate operations. This command
never changes the accepted catalog or the server's coverage registry.
"""
import argparse
import hashlib
import html
import importlib.util
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode()


def build(source_dir, output_root):
    source_bytes = (source_dir / "source.json").read_bytes()
    source = json.loads(source_bytes)
    geography_bytes = (source_dir / "geography.geojson").read_bytes()
    if sha(geography_bytes) != source["geographySha256"]:
        raise ValueError("Geographic input checksum mismatch")
    features = json.loads(geography_bytes)["features"]
    coverage_types = {
        "census-designated-place": ("census-cdp", "Census designated place", "Census-designated-place reference coverage; not an association, parcel, access or surveyed boundary."),
        "incorporated-place": ("census-incorporated-place", "Incorporated place", "Census-incorporated-place reference coverage; not an association, parcel, access or surveyed boundary."),
    }
    classification = coverage_types.get(source.get("coverageKind"))
    if classification is None:
        raise ValueError(f"Unsupported Census coverage kind: {source.get('coverageKind')!r}")
    id_prefix, coverage_type, boundary_note = classification
    core = [f for f in features if f.get("id") == source["coreFeatureId"]]
    if len(core) != 1 or core[0]["properties"].get("source") != "U.S. Census Bureau":
        raise ValueError("Expected one identified Census core feature")
    core = core[0]
    source_geo_id = str(core["properties"].get("sourceGeoId", ""))
    if (source["coreFeatureId"] != f"{id_prefix}/{source_geo_id}" or
            core["properties"].get("coverageType") != coverage_type):
        raise ValueError("Census core identity and coverage classification disagree")
    geometry = core["geometry"]
    # The current application coverage model is a single ring. Never silently
    # substitute a largest polygon or remove a hole to fit that model.
    if geometry["type"] != "Polygon" or len(geometry["coordinates"]) != 1:
        raise ValueError("Multipart or holed Census coverage needs an explicit application model update")
    ring = geometry["coordinates"][0]
    if len(ring) < 4 or ring[0] != ring[-1]:
        raise ValueError("Core ring must be closed")
    west, east = min(p[0] for p in ring), max(p[0] for p in ring)
    south, north = min(p[1] for p in ring), max(p[1] for p in ring)
    if not west < east or not south < north:
        raise ValueError("Core has no geographic extent")
    cosine = math.cos(math.radians((north + south) / 2))
    sy = min(760 / ((east - west) * cosine), 820 / (north - south))
    projection = dict(lngOrigin=(west + east) / 2, latOrigin=(north + south) / 2,
                      xOrigin=500, yOrigin=530, xScale=sy * cosine, yScale=sy)

    def project(p):
        return [500 + (p[0] - projection["lngOrigin"]) * projection["xScale"],
                530 - (p[1] - projection["latOrigin"]) * projection["yScale"]]

    def path(points, closed=False):
        return "M" + "L".join(",".join(str(round(v, 2)) for v in project(p)) for p in points) + ("Z" if closed else "")

    roads = [f for f in features if f["properties"].get("source") == "Pinellas County RoadCenterline"]
    if not roads or any(f["geometry"]["type"] != "LineString" for f in roads):
        raise ValueError("County roads must preserve their identified line parts")
    art = ['<rect x="20" y="20" width="960" height="1020" fill="#dedbc0"/>']
    for feature in features:
        if feature["properties"].get("source") != "USGS NHD":
            continue
        water = feature["geometry"]
        if water["type"] not in {"Polygon", "MultiPolygon"}:
            raise ValueError("Water must preserve polygon geometry")
        rings = water["coordinates"] if water["type"] == "Polygon" else [r for p in water["coordinates"] for r in p]
        d = "".join(path(r, True) for r in rings)
        art.append(f'<path d="{d}" fill-rule="evenodd" fill="#c6bfd1" stroke="#938bae" stroke-width="1.3"/>')
    for color, width in [("#998692", 10), ("#f8efd9", 7.5)]:
        art.append(f'<g fill="none" stroke="{color}" stroke-width="{width}" stroke-linecap="round" stroke-linejoin="round">')
        art.extend(f'<path d="{path(f["geometry"]["coordinates"])}"/>' for f in roads)
        art.append("</g>")
    candidates = []
    for road in roads:
        name = road["properties"].get("name")
        if not name:
            continue
        points = [project(p) for p in road["geometry"]["coordinates"]]
        for a, b in zip(points, points[1:]):
            length = math.dist(a, b)
            x, y = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
            if length > 12 and 90 < x < 910 and 90 < y < 970:
                candidates.append((length, str(name), x, y, math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))))
    labels, placed = set(), []
    for _, name, x, y, angle in sorted(candidates, reverse=True):
        if name in labels or len(placed) >= 18 or any(math.hypot(x - a, y - b) < 110 for a, b in placed):
            continue
        angle = angle - 180 if angle > 90 else angle + 180 if angle < -90 else angle
        art.append(f'<text transform="translate({x:.2f} {y:.2f}) rotate({angle:.2f})" text-anchor="middle" font-family="Georgia,serif" font-size="11.2" fill="#695572" stroke="#f2e9d3" stroke-width="3" paint-order="stroke">{html.escape(name)}</text>')
        placed.append((x, y)); labels.add(name)
    core_path = path(ring, True)
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="20 20 960 1020"><defs>'
           f'<mask id="spotlight" maskUnits="userSpaceOnUse" x="20" y="20" width="960" height="1020"><path d="{core_path}" fill="white"/></mask>'
           '<mask id="nearbyBlocksMask"><path d="" fill="white"/></mask><g id="nearbyBlocksArtwork"/>'
           '<g id="geographyArtwork">' + "".join(art) + '</g></defs>'
           '<rect x="20" y="20" width="960" height="1020" fill="#f6efdd"/>'
           '<use href="#geographyArtwork" opacity=".2"/>'
           '<use href="#geographyArtwork" mask="url(#spotlight)"/></svg>').encode()
    spec = importlib.util.spec_from_file_location("geography_import", ROOT / "scripts/import-ftw-geography.py")
    utils = importlib.util.module_from_spec(spec); spec.loader.exec_module(utils)
    bounds = dict(left=20, right=980, top=20, bottom=1040)
    anchors = utils.anchors_for({"features": roads}, projection, bounds, svg, source["id"])
    if len(anchors) != 4:
        raise ValueError("Four separated source-to-artwork road anchors are required")
    credits = source["additionalAttributions"]
    # Short display labels; complete provider wording and terms stay in notices.
    display_credits = [dict(credit, label=("U.S. Census Bureau" if credit["label"].startswith("U.S. Census Bureau")
                                         else "USGS NHD" if "Geological Survey" in credit["label"] else credit["label"])) for credit in credits]
    config = dict(id=source["id"], name=source["name"], width=1000, height=1060,
                  sourceProfile="county-census-usgs-v1", bounds=bounds, projection=projection,
                  artwork=f'./assets/neighborhoods/{source["id"]}.svg',
                  rasterArtwork=f'./assets/neighborhoods/{source["id"]}.webp',
                  coreBoundary=[project(p) for p in ring], overviewBounds=utils.overview_bounds(ring, projection),
                  attribution=source["attribution"], additionalAttributions=display_credits,
                  license=source["license"], licenseUrl=None,
                  sourceNotices=f'./data/{source["id"]}/source-notices.json',
                  geography=f'./data/{source["id"]}/geography.geojson',
                  coverageKind=source["coverageKind"],
                  boundaryNote=boundary_note)
    notices = dict(source["sourceNotices"], attribution=source["attribution"],
                   additionalAttributions=credits, sourceEvidence=source["sourceEvidence"],
                   acquiredAt=source["acquiredAt"], coverageKind=source["coverageKind"])
    notices_bytes = encoded(notices)
    provenance = dict(id=source["id"], sourceProfile=config["sourceProfile"],
                      acquiredAt=source["acquiredAt"], sourcePackageSha256=sha(source_bytes),
                      sourceGeometrySha256=sha(geography_bytes), rawSnapshotSha256=source["rawSnapshotSha256"],
                      rendererSha256=sha(Path(__file__).read_bytes()),
                      anchorUtilitySha256=sha((ROOT / "scripts/import-ftw-geography.py").read_bytes()),
                      coreFeatureId=source["coreFeatureId"], coverageKind=source["coverageKind"],
                      sourceEvidence=source["sourceEvidence"], sourceNoticesSha256=sha(notices_bytes),
                      coreMaskGeometrySha256=sha(core_path.encode()), nearbyMaskGeometrySha256=sha(b""),
                      anchors=4, roadFeatures=len(roads), overviewLabels=len(placed),
                      boundaryNote=config["boundaryNote"],
                      transformNotes="Source geographic geometry is retained. A local linear drawing projection is shared by artwork and pins. Nearby artwork is orientation context, not extra submission eligibility.")
    folder = output_root / "public/data" / source["id"]
    if (folder / "provenance.json").exists():
        prior = json.loads((folder / "provenance.json").read_text())
        raster = prior.get("rasterArtwork", {})
        if raster.get("sourceSha256") == sha(svg):
            provenance["rasterArtwork"] = raster
    outputs = {folder / "neighborhood.json": encoded(config), folder / "anchors.json": encoded(anchors),
               folder / "source-notices.json": notices_bytes, folder / "provenance.json": encoded(provenance),
               folder / "geography.geojson": geography_bytes,
               output_root / "public/assets/neighborhoods" / (source["id"] + ".svg"): svg}
    for file, data in outputs.items():
        file.parent.mkdir(parents=True, exist_ok=True); file.write_bytes(data)
    print(json.dumps({"id": source["id"], "roadFeatures": len(roads), "anchors": 4, "labels": len(placed), "output": str(output_root)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    args = parser.parse_args()
    build(args.source.resolve(), args.output_root.resolve())
