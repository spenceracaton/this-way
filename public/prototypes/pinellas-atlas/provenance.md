# Pinellas atlas geography provenance

The county outline is Pinellas County (FIPS 12103), extracted from the U.S. Census Bureau’s 2024 Cartographic Boundary File for counties at 1:500,000 scale. The polygon comes directly from the Census shapefile and is stored as longitude/latitude coordinates. It has four land rings and 473 vertices, including the small county islands; no separate offshore-water jurisdiction feature was selected. Its bounds are -82.8522 to -82.5876 longitude and 27.6119 to 28.1733 latitude. This generalized geography is for a regional overview.

Source: [2024 Census county cartographic boundaries](https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_county_500k.zip) · [Census cartographic boundary files](https://www.census.gov/geographies/mapping-files/time-series/geo/carto-boundary-file.html). Census Bureau geography is public domain.

Neighborhood centers use the polygon centroid of each prepared map’s coreBoundary, calculated in its map projection and converted back to longitude/latitude. Crescent Lake predates coreBoundary storage, so its prepared serviceCoverage ring supplies its centroid directly. Each atlas item links to that neighborhood’s existing raster map artwork.

Browse regions are conceptual groups, not official boundaries. Beaches & Islands includes Belleair Beach and Tierra Verde. The remaining groups use center latitude: 28.00° and above for North Pinellas; 27.84° to below 28.00° for Clearwater & Largo; below 27.84° for St. Petersburg & South. The longitude cutoff alone would incorrectly group inland neighborhoods such as Ridgecrest and Orange Terrace with the barrier beaches.
