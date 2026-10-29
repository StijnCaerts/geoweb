# WMTS Explorer

A static web application to explore and visualize [OGC WMTS](https://www.ogc.org/standard/wmts/) layers on an interactive map, built with [MapLibre GL JS](https://maplibre.org/), TypeScript and Vite.

## Features

- Enter a WMTS GetCapabilities URL (or a bare service endpoint) and browse all layers, with search.
- Add multiple layers, reorder them, toggle visibility and change opacity.
- Pick style, image format, tile matrix set and request encoding (RESTful or KVP).
- Controls for every WMTS dimension (e.g. `Time`, `Elevation`), including ISO 8601 interval expansion (`start/end/period`), prev/next stepping, animation and free text input.
- Legends, layer extent zoom, sample tile URL for debugging, globe view.
- Basemaps: OpenStreetMap raster, [OpenFreeMap](https://openfreemap.org/) vector styles (Liberty, Bright, Positron, Dark, Fiord) or none.
- Optional extra query parameters (e.g. API keys) for capabilities and tile requests.
- Shareable links: `?url=<capabilities url>` loads a service on startup.

## Limitations

- MapLibre renders Web Mercator, so only layers offered in a Web Mercator compatible tile matrix set (e.g. `EPSG:3857`, `GoogleMapsCompatible`) can be displayed. Other layers are listed but disabled.
- The browser must be allowed to fetch from the WMTS server, so the server needs to send CORS headers (`Access-Control-Allow-Origin`). On GitHub Pages (https) the service must also use https.

## Development

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # output in dist/
npm run preview
```
