# WMTS Explorer

A static web application to explore and visualize [OGC WMTS](https://www.ogc.org/standard/wmts/) and [OGC API – Tiles](https://ogcapi.ogc.org/tiles/) layers on an interactive map, built with [MapLibre GL JS](https://maplibre.org/), TypeScript and Vite.

## Features

- Enter a WMTS GetCapabilities URL (or a bare service endpoint) and browse all layers, with search.
- Or enter an OGC API landing page (or a `/collections` list or a single collection): every map and vector tile set of the dataset and its collections is listed. The service type is detected automatically.
- OGC API vector tiles (Mapbox Vector Tiles) are drawn with a generated style: one colour per source layer, for polygons, lines and points. Source layers are taken from the tile set metadata and discovered from the tiles themselves.
- OGC API `datetime` parameter, when the server declares the OGC API – Tiles datetime conformance class.
- Add multiple layers, reorder them, toggle visibility and change opacity.
- Pick style, image format, tile matrix set and request encoding (RESTful or KVP).
- Controls for every WMTS dimension (e.g. `Time`, `Elevation`), including ISO 8601 interval expansion (`start/end/period`), prev/next stepping, animation and free text input.
- Legends, layer extent zoom, sample tile URL for debugging, globe view.
- Basemaps: OpenStreetMap raster, [OpenFreeMap](https://openfreemap.org/) vector styles (Liberty, Bright, Positron, Dark, Fiord) or none.
- Optional extra query parameters (e.g. API keys) for capabilities and tile requests.
- Shareable links: `?url=<capabilities or landing page url>` loads a service on startup.
- Save services (including extra parameters) in the browser's local storage for quick access later.
- Optional tile request monitoring: request counts, errors, latency percentiles and tile sizes, aggregated per tile matrix set and zoom level.

## Limitations

- MapLibre renders Web Mercator, so only layers offered in a Web Mercator compatible tile matrix set (e.g. `EPSG:3857`, `GoogleMapsCompatible`, `WebMercatorQuad`) can be displayed. Other layers are listed but disabled. For OGC API, tile sets are only fetched when you add a layer, so incompatible layers are flagged at that moment.
- OGC API map tiles must be PNG, JPEG, WebP, GIF or AVIF; vector tiles must be Mapbox Vector Tiles. OGC API styles are not supported yet.
- The browser must be allowed to fetch from the server, so the server needs to send CORS headers (`Access-Control-Allow-Origin`). On GitHub Pages (https) the service must also use https.

## Development

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # output in dist/
npm run preview
```
