#!/usr/bin/env python3
"""Build bounded source-art derivatives and registration metadata for the map study.

Requires Pillow and svgpathtools. Original assets are read only; outputs live under
public/prototypes/continuous-map/art and public/prototypes/continuous-map/data/.
"""
from __future__ import annotations

import hashlib
import json
import math
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw
from svgpathtools import parse_path


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public/prototypes/continuous-map/art"
DATA_OUT = ROOT / "public/prototypes/continuous-map/data"
MAX_EDGE = 2048
QUALITY = 90
MAPS = [
    (ROOT / "public/data/neighborhood.json", "old-northeast"),
    (ROOT / "public/data/crescent-lake/neighborhood.json", "crescent-lake"),
]
NS = {"svg": "http://www.w3.org/2000/svg"}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def geographic_bounds(area: dict) -> list[list[float]]:
    p, b = area["projection"], area.get("artworkBounds", area["bounds"])
    west = p["lngOrigin"] + (b["left"] - p["xOrigin"]) / p["xScale"]
    east = p["lngOrigin"] + (b["right"] - p["xOrigin"]) / p["xScale"]
    north = p["latOrigin"] - (b["top"] - p["yOrigin"]) / p["yScale"]
    south = p["latOrigin"] - (b["bottom"] - p["yOrigin"]) / p["yScale"]
    return [[south, west], [north, east]]


def image_size(size: tuple[int, int]) -> tuple[int, int]:
    scale = min(1.0, MAX_EDGE / max(size))
    return tuple(max(1, round(value * scale)) for value in size)


def source_spotlight_mask(svg_path: Path, source_size: tuple[int, int]) -> Image.Image:
    """Rasterize the authored SVG spotlight path into source-raster coordinates."""
    root = ET.parse(svg_path).getroot()
    view_box = [float(x) for x in root.attrib["viewBox"].split()]
    if len(view_box) != 4:
        raise ValueError(f"Unsupported viewBox in {svg_path}")
    vx, vy, vw, vh = view_box
    width, height = source_size
    # The retained rasters are generated with preserveAspectRatio="none".
    sx, sy = width / vw, height / vh
    mask = root.find(".//svg:mask[@id='spotlight']", NS)
    if mask is None:
        raise ValueError(f"No source-art spotlight mask in {svg_path}")
    paths = mask.findall("svg:path", NS)
    if len(paths) != 1 or not paths[0].get("d"):
        raise ValueError(f"Spotlight mask shape changed; review {svg_path}")
    path = paths[0]
    svg_path_data = parse_path(path.attrib["d"])

    def project(point: complex) -> tuple[float, float]:
        return ((point.real - vx) * sx, (point.imag - vy) * sy)

    points: list[tuple[float, float]] = []
    # Half-unit samples retain the authored curved/angled edge at source scale.
    for segment in svg_path_data:
        steps = max(1, math.ceil(segment.length(error=0.01) * 2))
        for n in range(steps):
            points.append(project(segment.point(n / steps)))
    if len(points) < 3 or not svg_path_data.isclosed():
        raise ValueError(f"Spotlight path is not a closed polygon in {svg_path}")
    points.append(points[0])

    out = Image.new("L", source_size, 0)
    draw = ImageDraw.Draw(out)
    draw.polygon(points, fill=255)
    stroke_width = float(path.get("stroke-width", "0")) * (sx + sy) / 2
    if stroke_width > 0:
        draw.line(points, fill=255, width=max(1, round(stroke_width)), joint="curve")
    return out


def write_webp(im: Image.Image, path: Path) -> None:
    im.save(path, "WEBP", quality=QUALITY, method=6)


def overlap_diagnostics(entries: list[dict]) -> dict:
    (s1, w1), (n1, e1) = entries[0]["bounds"]
    (s2, w2), (n2, e2) = entries[1]["bounds"]
    south, west, north, east = max(s1, s2), max(w1, w2), min(n1, n2), min(e1, e2)
    overlap = None
    ratio = None
    if south < north and west < east:
        overlap = [[south, west], [north, east]]
        overlap_area = (north - south) * (east - west) * math.cos(math.radians((north + south) / 2))
        areas = [
            (n - s) * (e - w) * math.cos(math.radians((n + s) / 2))
            for (s, w), (n, e) in [entries[0]["bounds"], entries[1]["bounds"]]
        ]
        ratio = {
            "overlapPercentOfOldNortheastRect": round(overlap_area / areas[0] * 100, 2),
            "overlapPercentOfCrescentLakeRect": round(overlap_area / areas[1] * 100, 2),
        }
    return {
        "rectangularBoundsOverlap": overlap,
        "overlapPercent": ratio,
        "meaning": "Rectangle intersection only; not proof that rendered roads, labels, or landmarks agree.",
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    entries = []
    originals = {}
    for config_path, map_id in MAPS:
        area = json.loads(config_path.read_text())
        svg_path = ROOT / "public" / area["artwork"].removeprefix("./")
        raster_path = ROOT / "public" / area["rasterArtwork"].removeprefix("./")
        svg_hash, raster_hash = sha256(svg_path), sha256(raster_path)
        with Image.open(raster_path) as source:
            source = source.convert("RGBA")
            original_size = source.size
            target_size = image_size(original_size)
            resized = source.resize(target_size, Image.Resampling.LANCZOS)
            spotlight = source_spotlight_mask(svg_path, original_size).resize(
                target_size, Image.Resampling.LANCZOS
            )
            masked = resized.copy()
            masked.putalpha(ImageChops.multiply(resized.getchannel("A"), spotlight))

        full_name = f"{map_id}.webp"
        mask_name = f"{map_id}-spotlight.webp"
        full_path, mask_path = OUT / full_name, OUT / mask_name
        write_webp(resized, full_path)
        write_webp(masked, mask_path)
        bounds = geographic_bounds(area)
        entries.append({
            "id": map_id,
            "name": area["name"],
            "url": f"./art/{full_name}",
            "bounds": bounds,
            "width": target_size[0],
            "height": target_size[1],
            "bytes": full_path.stat().st_size,
            "decodedBytes": target_size[0] * target_size[1] * 4,
            "sourceSha256": svg_hash,
            "sourceRasterSha256": raster_hash,
            "spotlightUrl": f"./art/{mask_name}",
            "maskBytes": mask_path.stat().st_size,
            "maskDecodedBytes": target_size[0] * target_size[1] * 4,
            "maskStatus": {
                "status": "source-spotlight-extracted",
                "sourceSvgId": "spotlight",
                "meaning": "Authored visual emphasis mask only; not a service-eligibility or official neighborhood boundary.",
            },
            "original": {"width": original_size[0], "height": original_size[1]},
        })
        originals[map_id] = {
            "svg": {"path": str(svg_path.relative_to(ROOT)), "sha256": svg_hash, "bytes": svg_path.stat().st_size},
            "raster": {"path": str(raster_path.relative_to(ROOT)), "sha256": raster_hash, "width": original_size[0], "height": original_size[1], "bytes": raster_path.stat().st_size},
        }

    DATA_OUT.mkdir(parents=True, exist_ok=True)
    (DATA_OUT / "artwork.json").write_text(json.dumps(entries, indent=2) + "\n")
    alignment = {
        "version": 1,
        "coordinateModel": "per-source affine longitude/latitude; inverse of projection applied to image bounds",
        "artworkBounds": {entry["id"]: entry["bounds"] for entry in entries},
        "unionBounds": [
            [min(e["bounds"][0][0] for e in entries), min(e["bounds"][0][1] for e in entries)],
            [max(e["bounds"][1][0] for e in entries), max(e["bounds"][1][1] for e in entries)],
        ],
        "overlap": overlap_diagnostics(entries),
        "sources": originals,
        "registration": {
            "fitting": "Not performed. Existing projection parameters retained.",
            "heldOutAnchorSet": {"status": "blocked-awaiting-independent-street-intersections", "anchors": [], "reason": "No independent held-out street-intersection coordinates are retained for these two maps. Source-derived pins or fit anchors cannot validate geographic accuracy."},
            "frozenCriteria": {
                "declaredZoomLevels": [15, 16, 17],
                "maxHeldOutResidualMeters": 10,
                "maxHeldOutResidualPixelsAtZoom16": 5,
                "readability": "At all three zoom levels, inspect source artwork and neutral base context on both sides of the crossing; require distinct street paths, no duplicated/conflicting road or place labels, and visible context through the overlap and one deliberately unillustrated gap. Any ambiguous road continuation or landmark displacement is a fail.",
                "ownership": "Review the crossing in full-art and each authored spotlight mode; spotlight edges are aesthetic emphasis, never neighborhood eligibility edges.",
                "independence": "Freeze a minimum of 8 named street intersections per image (4 near the footprint edges and 4 internal), sourced from independently documented street-centerline data. Reserve at least 4 further intersections per image for held-out validation; do not tune on those points.",
                "status": "Criteria recorded before fitting; the named independent coordinates must be added and hashed before any fitting begins.",
            },
        },
        "limits": [
            "Rectangular overlap is not a visual seam or registration finding.",
            "Source spotlight masks retain the SVG visual-emphasis geometry, including its authored stroke; they are not official neighborhood boundaries.",
            "No held-out geographic accuracy or seamless cross-map ownership has been established.",
        ],
    }
    prior_alignment_path = DATA_OUT / "alignment.json"
    if prior_alignment_path.exists():
        prior = json.loads(prior_alignment_path.read_text())
        road_report = prior.get("sourceRoadAgreement")
        if road_report:
            expected_hashes = {
                "countyContext": sha256(ROOT / "public/prototypes/continuous-map/data/context.geojson"),
                "old-northeast": sha256(ROOT / "public/data/geography.json"),
                "crescent-lake": sha256(ROOT / "public/data/crescent-lake/geography.json"),
            }
            recorded_hashes = {key: value.get("sha256") for key, value in road_report.get("inputs", {}).items()}
            if recorded_hashes == expected_hashes:
                alignment["sourceRoadAgreement"] = road_report
    prior_alignment_path.write_text(json.dumps(alignment, indent=2) + "\n")
    print(json.dumps({"artworks": entries, "alignment": "public/prototypes/continuous-map/data/alignment.json"}, indent=2))


if __name__ == "__main__":
    main()
