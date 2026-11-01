import {
  addProtocol,
  type FilterSpecification,
  type LayerSpecification,
  type LngLatBoundsLike,
  type Map as MlMap,
  type RasterTileSource,
  type VectorTileSource,
} from 'maplibre-gl';
import { expandDimension, type DimensionDomain } from './dimensions';
import { el, escapeHtml, safeHttpUrl, select } from './dom';
import { upgradeToPageProtocol } from './http';
import { gunzipIfNeeded, mvtLayerNames } from './mvt';
import { compatibleMatrixSets, type WmtsCapabilities, type WmtsDimension, type WmtsLayer } from './wmts';
import type { TileMonitor } from './perf';

const MAX_LAT = 85.051129;
const PLAY_INTERVAL_MS = 1500;
const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324', '#469990', '#808000'];
const FILL_OPACITY = 0.35;
type VectorKind = 'fill' | 'line' | 'circle';
const VECTOR_KINDS: VectorKind[] = ['fill', 'line', 'circle'];

type Encoding = 'REST' | 'KVP';

interface ActiveLayer {
  id: string;
  caps: WmtsCapabilities;
  layer: WmtsLayer;
  style: string;
  format: string;
  tms: string;
  encoding: Encoding;
  dims: Record<string, string>;
  domains: Record<string, DimensionDomain>;
  opacity: number;
  visible: boolean;
  /** Bumped on every change so MapLibre treats the tile URLs as new and drops cached tiles. */
  rev: number;
  timers: Set<number>;
  errors: number;
  /** True once a tile loaded successfully with the current settings. */
  loaded: boolean;
  notice?: string;
  /** Vector tile source layers, in order of discovery. */
  sourceLayers: string[];
  card?: HTMLElement;
  errorEl?: HTMLElement;
  sourceLayersEl?: HTMLElement;
}

export const SOURCE_PREFIX = 'wmts-src-';
export const LAYER_PREFIX = 'wmts-lyr-';
const sourceId = (id: string) => `${SOURCE_PREFIX}${id}`;
const layerId = (id: string) => `${LAYER_PREFIX}${id}`;
const vectorLayerId = (id: string, index: number, kind: VectorKind) => `${layerId(id)}-${index}-${kind}`;
/** MapLibre only loads tiles of sources used by a layer, so this empty layer makes source layers discoverable. */
const probeLayerId = (id: string) => `${layerId(id)}-probe`;

function vectorColor(a: ActiveLayer, index: number): string {
  return PALETTE[(Number(a.id) - 1 + index) % PALETTE.length];
}

function opacityPaint(kind: VectorKind | 'raster', opacity: number): Record<string, number> {
  switch (kind) {
    case 'raster':
      return { 'raster-opacity': opacity };
    case 'fill':
      return { 'fill-opacity': FILL_OPACITY * opacity };
    case 'line':
      return { 'line-opacity': opacity };
    case 'circle':
      return { 'circle-opacity': opacity, 'circle-stroke-opacity': opacity };
  }
}

const GEOMETRY_TYPES: Record<VectorKind, string[]> = {
  fill: ['Polygon', 'MultiPolygon'],
  line: ['LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'],
  circle: ['Point', 'MultiPoint'],
};

function clampBbox(b: WmtsLayer['bbox']): [number, number, number, number] | undefined {
  if (!b || b[0] >= b[2] || b[1] >= b[3]) return undefined;
  const clampLat = (v: number) => Math.max(-MAX_LAT, Math.min(MAX_LAT, v));
  return [Math.max(-180, b[0]), clampLat(b[1]), Math.min(180, b[2]), clampLat(b[3])];
}

function lngLatToTile(lng: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const rad = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  const clamp = (v: number) => Math.max(0, Math.min(n - 1, v));
  return [clamp(x), clamp(y)];
}

function field(label: string, control: HTMLElement): HTMLElement {
  return el('label', { class: 'field' }, el('span', { text: label }), control);
}

function iconButton(text: string, title: string, onclick: () => void, disabled = false) {
  return el('button', { type: 'button', class: 'icon', text, title, 'aria-label': title, onclick, disabled });
}

export class LayerManager {
  private layers = new Map<string, ActiveLayer>();
  /** Layer ids, top-most first. */
  private order: string[] = [];
  private counter = 0;

  constructor(
    private map: MlMap,
    private container: HTMLElement,
    private monitor?: TileMonitor,
  ) {
    // Tiles are requested as wmts://<id>/<rev>/<z>/<x>/<y> and translated to the real WMTS
    // request here, which lets us map XYZ zoom levels onto arbitrary TileMatrix identifiers.
    addProtocol('wmts', async (params, abort) => {
      const [id, rev, z, x, y] = params.url.slice('wmts://'.length).split('/');
      const a = this.layers.get(id);
      const url = a && this.tileUrl(a, Number(z), Number(x), Number(y));
      if (!url) throw Object.assign(new Error(`Tile ${z}/${x}/${y} is outside the layer's tile range`), { name: 'AbortError' });
      const start = performance.now();
      let res: Response;
      try {
        res = await fetch(url, { signal: abort.signal });
      } catch (e) {
        if ((e as Error).name !== 'AbortError') this.recordTile(a, Number(z), start, NaN, 0, 0);
        throw e;
      }
      const ttfb = performance.now() - start;
      if (!res.ok) {
        const status = res.status;
        this.recordTile(a, Number(z), start, ttfb, 0, status);
        if (a.encoding === 'REST' && !a.loaded && a.caps.kvpUrl && status >= 400 && status < 500 && status !== 404) {
          this.fallBackToKvp(a, status);
        }
        // Failures of requests made with outdated settings are not worth reporting.
        if (Number(rev) !== a.rev) throw Object.assign(new Error('Outdated tile request'), { name: 'AbortError' });
        throw new Error(`HTTP ${status} for ${url}`);
      }
      a.loaded = true;
      let data = await res.arrayBuffer();
      this.recordTile(a, Number(z), start, ttfb, data.byteLength, res.status);
      if (a.layer.dataType === 'vector') {
        data = await gunzipIfNeeded(data);
        this.discoverSourceLayers(a, mvtLayerNames(data));
      }
      return { data };
    });

    // Source layers discovered while a new basemap style was loading may be missing.
    map.on('style.load', () => this.layers.forEach((a) => this.syncVectorLayers(a)));

    map.on('error', (e) => {
      const sid = (e as { sourceId?: string }).sourceId;
      if ((e.error as Partial<Error> | undefined)?.name === 'AbortError') return;
      const a = sid?.startsWith(SOURCE_PREFIX) ? this.layers.get(sid.slice(SOURCE_PREFIX.length)) : undefined;
      if (!a) {
        console.error(e.error);
        return;
      }
      a.errors++;
      if (a.errorEl) {
        a.errorEl.textContent = `${a.errors} tile request(s) failed. Last: ${e.error?.message ?? 'unknown error'}`;
        a.errorEl.hidden = false;
      }
    });

    this.render();
  }

  private recordTile(a: ActiveLayer, z: number, start: number, ttfb: number, bytes: number, status: number): void {
    if (!this.monitor?.enabled) return;
    this.monitor.record({
      layerKey: a.id,
      layerTitle: a.layer.title,
      tileMatrixSet: a.tms,
      tileMatrix: a.caps.tileMatrixSets.get(a.tms)?.webMercator?.zoomToMatrix.get(z) ?? String(z),
      zoom: z,
      ttfb,
      duration: performance.now() - start,
      bytes,
      status,
    });
  }

  add(caps: WmtsCapabilities, layer: WmtsLayer): void {
    const sets = compatibleMatrixSets(caps, layer);
    if (!sets.length) return;

    const domains: Record<string, DimensionDomain> = {};
    const dims: Record<string, string> = {};
    for (const d of layer.dimensions) {
      const domain = expandDimension(d);
      domains[d.identifier] = domain;
      dims[d.identifier] =
        d.default ?? (domain.temporal ? domain.values[domain.values.length - 1] : domain.values[0]) ?? '';
    }

    const a: ActiveLayer = {
      id: String(++this.counter),
      caps,
      layer,
      style: (layer.styles.find((s) => s.isDefault) ?? layer.styles[0])?.identifier ?? 'default',
      format: '',
      tms: sets[0].identifier,
      encoding: layer.resourceUrls.some((r) => r.resourceType === 'tile') ? 'REST' : 'KVP',
      dims,
      domains,
      opacity: 1,
      visible: true,
      rev: 0,
      timers: new Set(),
      errors: 0,
      loaded: false,
      sourceLayers: [...(layer.vectorLayers ?? [])],
    };
    a.format = this.formats(a)[0];

    this.layers.set(a.id, a);
    this.order.unshift(a.id);
    this.addToMap(a);
    this.render();

    const bbox = clampBbox(layer.bbox);
    if (bbox) {
      const view = this.map.getBounds();
      const [w, s, e, n] = bbox;
      const outside = e < view.getWest() || w > view.getEast() || n < view.getSouth() || s > view.getNorth();
      const tiny = e - w < (view.getEast() - view.getWest()) / 8;
      if (outside || tiny || this.map.getZoom() < this.zoomRange(a).min) this.zoomTo(a);
    }
  }

  /** RESTful tile templates usable with the current tile matrix set. */
  private tileResources(a: ActiveLayer) {
    return a.layer.resourceUrls.filter(
      (r) => r.resourceType === 'tile' && (!r.tileMatrixSet || r.tileMatrixSet === a.tms),
    );
  }

  private formats(a: ActiveLayer): string[] {
    const list = a.encoding === 'REST' ? this.tileResources(a).map((r) => r.format) : a.layer.formats;
    const unique = [...new Set(list.filter(Boolean))];
    return unique.length ? unique : ['image/png'];
  }

  private tileUrl(a: ActiveLayer, z: number, x: number, y: number): string | undefined {
    const matrix = a.caps.tileMatrixSets.get(a.tms)?.webMercator?.zoomToMatrix.get(z);
    if (matrix === undefined) return undefined;
    const limits = a.layer.tileMatrixLimits[a.tms];
    if (limits) {
      const lim = limits.get(matrix);
      if (!lim || y < lim.minRow || y > lim.maxRow || x < lim.minCol || x > lim.maxCol) return undefined;
    }
    let url: URL;

    if (a.encoding === 'REST') {
      const tiles = this.tileResources(a);
      const resource = tiles.find((r) => r.format === a.format) ?? tiles[0];
      if (!resource) return undefined;
      const vars: Record<string, string> = {
        tilematrixset: a.tms,
        tilematrix: matrix,
        tilerow: String(y),
        tilecol: String(x),
        style: a.style,
      };
      if (!a.layer.dimensionsAsQuery) for (const [k, v] of Object.entries(a.dims)) vars[k.toLowerCase()] = v;
      const filled = resource.template.replace(/\{([^}]+)\}/g, (m, name: string) => {
        const v = vars[name.toLowerCase()];
        return v === undefined ? m : encodeURIComponent(v).replace(/%3A/gi, ':');
      });
      url = new URL(filled, a.caps.url);
      if (a.layer.dimensionsAsQuery) for (const [k, v] of Object.entries(a.dims)) if (v) url.searchParams.set(k, v);
    } else {
      url = new URL(a.caps.kvpUrl ?? a.caps.url.split('?')[0], a.caps.url);
      const p = url.searchParams;
      p.set('SERVICE', 'WMTS');
      p.set('REQUEST', 'GetTile');
      p.set('VERSION', '1.0.0');
      p.set('LAYER', a.layer.identifier);
      p.set('STYLE', a.style);
      p.set('FORMAT', a.format);
      p.set('TILEMATRIXSET', a.tms);
      p.set('TILEMATRIX', matrix);
      p.set('TILEROW', String(y));
      p.set('TILECOL', String(x));
      for (const [k, v] of Object.entries(a.dims)) p.set(k, v);
    }
    a.caps.extraParams.forEach((v, k) => url.searchParams.set(k, v));
    return upgradeToPageProtocol(url).href;
  }

  /** Some servers advertise RESTful templates they don't actually serve. */
  private fallBackToKvp(a: ActiveLayer, status: number): void {
    if (a.encoding !== 'REST') return;
    a.encoding = 'KVP';
    if (!this.formats(a).includes(a.format)) a.format = this.formats(a)[0];
    a.notice = `RESTful tile requests were rejected (HTTP ${status}), switched to KVP.`;
    this.refresh(a);
    this.rerenderCard(a);
  }

  /** MapLibre layer ids of an entry, bottom to top: all fills, then all lines, then all points. */
  private mapLayerIds(a: ActiveLayer): string[] {
    if (a.layer.dataType !== 'vector') return [layerId(a.id)];
    return [
      probeLayerId(a.id),
      ...VECTOR_KINDS.flatMap((kind) => a.sourceLayers.map((_, i) => vectorLayerId(a.id, i, kind))),
    ];
  }

  /** The bottom-most MapLibre layer of the nearest entry above, to insert below it. */
  private beforeId(id: string): string | undefined {
    for (let j = this.order.indexOf(id) - 1; j >= 0; j--) {
      const above = this.mapLayerIds(this.layers.get(this.order[j])!).find((l) => this.map.getLayer(l));
      if (above) return above;
    }
    return undefined;
  }

  private vectorStyleLayer(a: ActiveLayer, index: number, kind: VectorKind): LayerSpecification {
    const color = vectorColor(a, index);
    const filter: FilterSpecification = ['match', ['geometry-type'], GEOMETRY_TYPES[kind], true, false];
    const common = {
      id: vectorLayerId(a.id, index, kind),
      source: sourceId(a.id),
      'source-layer': a.sourceLayers[index],
      filter,
      layout: { visibility: a.visible ? ('visible' as const) : ('none' as const) },
    };
    switch (kind) {
      case 'fill':
        return { ...common, type: 'fill', paint: { 'fill-color': color, ...opacityPaint(kind, a.opacity) } };
      case 'line':
        return { ...common, type: 'line', paint: { 'line-color': color, 'line-width': 1.5, ...opacityPaint(kind, a.opacity) } };
      case 'circle':
        return {
          ...common,
          type: 'circle',
          paint: {
            'circle-color': color,
            'circle-radius': 4,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 1,
            ...opacityPaint(kind, a.opacity),
          },
        };
    }
  }

  /** Adds style layers for vector tile source layers that are not on the map yet. */
  private syncVectorLayers(a: ActiveLayer): void {
    if (a.layer.dataType !== 'vector' || !this.map.getSource(sourceId(a.id))) return;
    const specs: LayerSpecification[] = [
      {
        id: probeLayerId(a.id),
        type: 'circle',
        source: sourceId(a.id),
        'source-layer': '__wmts_explorer_probe__',
        layout: { visibility: a.visible ? 'visible' : 'none' },
      },
      ...VECTOR_KINDS.flatMap((kind) => a.sourceLayers.map((_, i) => this.vectorStyleLayer(a, i, kind))),
    ];
    try {
      specs.forEach((spec, k) => {
        if (this.map.getLayer(spec.id)) return;
        const before = specs.slice(k + 1).find((l) => this.map.getLayer(l.id))?.id ?? this.beforeId(a.id);
        this.map.addLayer(spec, before);
      });
    } catch {
      // The style is being replaced; this runs again on 'style.load'.
    }
  }

  private discoverSourceLayers(a: ActiveLayer, names: string[]): void {
    const added = names.filter((n) => !a.sourceLayers.includes(n));
    if (!added.length) return;
    a.sourceLayers.push(...added);
    this.syncVectorLayers(a);
    this.renderSourceLayers(a);
  }

  private renderSourceLayers(a: ActiveLayer): void {
    a.sourceLayersEl?.replaceChildren(
      ...(a.sourceLayers.length
        ? a.sourceLayers.map((name, i) =>
            el('span', { class: 'badge source-layer' }, el('span', { class: 'swatch', style: `background:${vectorColor(a, i)}` }), name),
          )
        : [el('span', { class: 'hint small', text: 'Source layers appear once tiles load.' })]),
    );
  }

  private setVisibility(a: ActiveLayer): void {
    for (const id of this.mapLayerIds(a)) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', a.visible ? 'visible' : 'none');
    }
  }

  private applyOpacity(a: ActiveLayer): void {
    if (a.layer.dataType !== 'vector') {
      this.map.setPaintProperty(layerId(a.id), 'raster-opacity', a.opacity);
      return;
    }
    for (const kind of VECTOR_KINDS) {
      a.sourceLayers.forEach((_, i) => {
        const id = vectorLayerId(a.id, i, kind);
        if (!this.map.getLayer(id)) return;
        for (const [prop, value] of Object.entries(opacityPaint(kind, a.opacity))) {
          this.map.setPaintProperty(id, prop as Parameters<MlMap['setPaintProperty']>[1], value);
        }
      });
    }
  }

  private removeFromMap(a: ActiveLayer): void {
    for (const id of this.mapLayerIds(a)) if (this.map.getLayer(id)) this.map.removeLayer(id);
    this.map.removeSource(sourceId(a.id));
  }

  private addToMap(a: ActiveLayer): void {
    const wm = a.caps.tileMatrixSets.get(a.tms)!.webMercator!;
    const zoom = this.zoomRange(a);
    const { providerName, providerSite } = a.caps;
    const site = safeHttpUrl(providerSite);
    const attribution = a.layer.attribution
      ? escapeHtml(a.layer.attribution)
      : providerName
        ? site
          ? `<a href="${escapeHtml(site)}" target="_blank" rel="noopener">${escapeHtml(providerName)}</a>`
          : escapeHtml(providerName)
        : undefined;
    const source = {
      tiles: [`wmts://${a.id}/${a.rev}/{z}/{x}/{y}`],
      minzoom: zoom.min,
      maxzoom: zoom.max,
      bounds: clampBbox(a.layer.bbox),
      attribution,
    };

    if (a.layer.dataType === 'vector') {
      // MapLibre requires 512 for vector sources; z/x/y addressing does not depend on it.
      this.map.addSource(sourceId(a.id), { type: 'vector', ...source });
      this.syncVectorLayers(a);
      return;
    }
    this.map.addSource(sourceId(a.id), { type: 'raster', tileSize: wm.tileSize, ...source });
    this.map.addLayer(
      {
        id: layerId(a.id),
        type: 'raster',
        source: sourceId(a.id),
        layout: { visibility: a.visible ? 'visible' : 'none' },
        paint: { 'raster-opacity': a.opacity, 'raster-fade-duration': 0 },
      },
      this.beforeId(a.id),
    );
  }

  private resetErrors(a: ActiveLayer): void {
    a.errors = 0;
    if (a.errorEl) a.errorEl.hidden = true;
  }

  /** Reloads tiles after a change that keeps the tile grid (style, format, dimensions). */
  private refresh(a: ActiveLayer): void {
    a.rev++;
    this.resetErrors(a);
    const src = this.map.getSource<RasterTileSource | VectorTileSource>(sourceId(a.id));
    src?.setTiles([`wmts://${a.id}/${a.rev}/{z}/{x}/{y}`]);
  }

  /** Recreates the source after a change of the tile grid (tile matrix set). */
  private rebuild(a: ActiveLayer): void {
    this.removeFromMap(a);
    a.rev++;
    this.resetErrors(a);
    this.addToMap(a);
  }

  remove(id: string): void {
    const a = this.layers.get(id);
    if (!a) return;
    a.timers.forEach((t) => clearInterval(t));
    this.removeFromMap(a);
    this.layers.delete(id);
    this.order = this.order.filter((o) => o !== id);
    this.render();
  }

  private move(id: string, delta: number): void {
    const i = this.order.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= this.order.length) return;
    [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
    const before = this.beforeId(id);
    for (const l of this.mapLayerIds(this.layers.get(id)!)) if (this.map.getLayer(l)) this.map.moveLayer(l, before);
    this.render();
  }

  private zoomTo(a: ActiveLayer): void {
    const bbox = clampBbox(a.layer.bbox);
    if (!bbox) return;
    const camera = this.map.cameraForBounds(bbox as LngLatBoundsLike, { padding: 40 });
    if (camera) this.map.easeTo({ ...camera, zoom: Math.max(camera.zoom ?? 0, this.zoomRange(a).min) });
  }

  /** Zoom levels with tiles, narrowed by the layer's TileMatrixSetLimits when declared. */
  private zoomRange(a: ActiveLayer): { min: number; max: number } {
    const wm = a.caps.tileMatrixSets.get(a.tms)!.webMercator!;
    const limits = a.layer.tileMatrixLimits[a.tms];
    const zooms = [...wm.zoomToMatrix].filter(([, m]) => !limits || limits.has(m)).map(([z]) => z);
    return zooms.length ? { min: Math.min(...zooms), max: Math.max(...zooms) } : { min: wm.minZoom, max: wm.maxZoom };
  }

  private sampleTileUrl(a: ActiveLayer): string | undefined {
    if (!a.caps.tileMatrixSets.get(a.tms)?.webMercator) return undefined;
    const zoom = this.zoomRange(a);
    const z = Math.max(zoom.min, Math.min(zoom.max, Math.floor(this.map.getZoom())));
    const c = this.map.getCenter();
    const [x, y] = lngLatToTile(c.lng, c.lat, z);
    return this.tileUrl(a, z, x, y);
  }

  private render(): void {
    if (!this.order.length) {
      this.container.replaceChildren(
        el('p', { class: 'hint', text: 'No layers on the map yet. Load a service and add layers from the list.' }),
      );
      return;
    }
    this.container.replaceChildren(...this.order.map((id) => this.buildCard(this.layers.get(id)!)));
  }

  private rerenderCard(a: ActiveLayer): void {
    const old = a.card;
    const card = this.buildCard(a);
    old?.replaceWith(card);
  }

  private buildCard(a: ActiveLayer): HTMLElement {
    // Animations are bound to the controls of the previous card, so stop them.
    a.timers.forEach((t) => clearInterval(t));
    a.timers.clear();
    const L = a.layer;
    const index = this.order.indexOf(a.id);
    const sets = compatibleMatrixSets(a.caps, L);
    const hasRest = L.resourceUrls.some((r) => r.resourceType === 'tile');
    const style = L.styles.find((s) => s.identifier === a.style);
    const legendUrl = safeHttpUrl(style?.legendUrl);

    const header = el(
      'div',
      { class: 'card-header' },
      el('input', {
        type: 'checkbox',
        checked: a.visible,
        title: 'Show / hide',
        onchange: (e: Event) => {
          a.visible = (e.target as HTMLInputElement).checked;
          this.setVisibility(a);
        },
      }),
      el(
        'div',
        { class: 'card-title' },
        el('strong', { text: L.title }),
        el('small', { text: [L.identifier, L.dataType === 'vector' ? 'vector tiles' : '', a.caps.title].filter(Boolean).join(' · ') }),
      ),
      el(
        'div',
        { class: 'card-actions' },
        iconButton('⤢', 'Zoom to layer extent', () => this.zoomTo(a), !L.bbox),
        iconButton('↑', 'Move up', () => this.move(a.id, -1), index === 0),
        iconButton('↓', 'Move down', () => this.move(a.id, 1), index === this.order.length - 1),
        iconButton('✕', 'Remove layer', () => this.remove(a.id)),
      ),
    );

    const opacity = el('input', {
      type: 'range',
      min: '0',
      max: '1',
      step: '0.05',
      value: String(a.opacity),
      oninput: () => {
        a.opacity = Number(opacity.value);
        this.applyOpacity(a);
      },
    });

    const formats = this.formats(a);
    const errorEl = el('p', { class: 'error small', hidden: a.errors === 0 });
    if (a.errors) errorEl.textContent = `${a.errors} tile request(s) failed.`;
    a.errorEl = errorEl;
    a.sourceLayersEl = L.dataType === 'vector' ? el('div', { class: 'badges source-layers' }) : undefined;
    this.renderSourceLayers(a);

    const card = el(
      'article',
      { class: 'card' },
      header,
      L.abstract ? el('details', {}, el('summary', { text: 'Description' }), el('p', { text: L.abstract })) : null,
      field('Opacity', opacity),
      L.styles.length > 1
        ? field(
            'Style',
            select(
              L.styles.map((s) => ({ value: s.identifier, label: s.title })),
              a.style,
              (v) => {
                a.style = v;
                this.refresh(a);
                this.rerenderCard(a);
              },
            ),
          )
        : null,
      hasRest && a.caps.kvpUrl
        ? field(
            'Request encoding',
            select(
              [
                { value: 'REST', label: 'RESTful (ResourceURL)' },
                { value: 'KVP', label: 'KVP (GetTile)' },
              ],
              a.encoding,
              (v) => {
                a.encoding = v as Encoding;
                a.notice = undefined;
                const available = this.formats(a);
                if (!available.includes(a.format)) a.format = available[0];
                this.refresh(a);
                this.rerenderCard(a);
              },
            ),
          )
        : null,
      formats.length > 1
        ? field(
            'Format',
            select(
              formats.map((f) => ({ value: f, label: f })),
              a.format,
              (v) => {
                a.format = v;
                this.refresh(a);
              },
            ),
          )
        : null,
      sets.length > 1
        ? field(
            'Tile matrix set',
            select(
              sets.map((s) => ({
                value: s.identifier,
                label: `${s.identifier} (z${s.webMercator!.minZoom}–${s.webMercator!.maxZoom})`,
              })),
              a.tms,
              (v) => {
                a.tms = v;
                const available = this.formats(a);
                if (!available.includes(a.format)) a.format = available[0];
                this.rebuild(a);
                this.rerenderCard(a);
              },
            ),
          )
        : null,
      a.sourceLayersEl ? field('Source layers', a.sourceLayersEl) : null,
      ...L.dimensions.map((d) => this.dimensionControl(a, d)),
      L.tileMatrixLimits[a.tms]
        ? el('p', {
            class: 'hint small',
            text: `Tiles available at zoom levels ${this.zoomRange(a).min}–${this.zoomRange(a).max}.`,
          })
        : null,
      a.notice ? el('p', { class: 'hint small', text: a.notice }) : null,
      legendUrl ? el('div', { class: 'legend' }, el('img', { src: legendUrl, alt: `Legend for ${L.title}` })) : null,
      errorEl,
      el(
        'div',
        { class: 'card-footer' },
        el('button', {
          type: 'button',
          class: 'link',
          text: 'Open sample tile',
          title: 'Open the tile request for the map centre in a new tab',
          onclick: () => {
            const url = this.sampleTileUrl(a);
            if (url) window.open(url, '_blank', 'noopener');
          },
        }),
      ),
    );
    a.card = card;
    return card;
  }

  private dimensionControl(a: ActiveLayer, dim: WmtsDimension): HTMLElement {
    const id = dim.identifier;
    const { values, truncated, temporal } = a.domains[id];
    const name = dim.title && dim.title !== id ? `${dim.title} (${id})` : id;
    const info = [
      values.length ? `${values.length} value${values.length === 1 ? '' : 's'}` : 'free input',
      truncated ? 'most recent only' : '',
      dim.uom ?? '',
      dim.default ? `default ${dim.default}` : '',
    ]
      .filter(Boolean)
      .join(' · ');

    const text = el('input', {
      type: 'text',
      class: 'dim-text',
      value: a.dims[id],
      title: 'Value sent to the server. You can type any value.',
      onchange: () => setValue(text.value.trim()),
    });

    let indexed: HTMLSelectElement | HTMLInputElement | undefined;
    if (values.length > 1 && values.length <= 300) {
      indexed = select(
        values.map((v) => ({ value: v, label: v })),
        a.dims[id],
        (v) => setValue(v),
      );
    } else if (values.length > 300) {
      const range = el('input', {
        type: 'range',
        min: '0',
        max: String(values.length - 1),
        step: '1',
        oninput: () => (text.value = values[Number(range.value)]),
        onchange: () => setValue(values[Number(range.value)]),
      });
      indexed = range;
    }

    const syncIndexed = (v: string) => {
      if (!indexed) return;
      const i = values.indexOf(v);
      if (i < 0) return;
      indexed.value = indexed instanceof HTMLSelectElement ? v : String(i);
    };
    syncIndexed(a.dims[id]);
    if (indexed instanceof HTMLInputElement && values.indexOf(a.dims[id]) < 0) {
      indexed.value = String(temporal ? values.length - 1 : 0);
    }

    const setValue = (v: string) => {
      a.dims[id] = v;
      text.value = v;
      syncIndexed(v);
      this.refresh(a);
    };

    const step = (n: number) => {
      if (!values.length) return;
      let i = values.indexOf(a.dims[id]);
      if (i < 0) i = n > 0 ? -1 : values.length;
      setValue(values[(i + n + values.length) % values.length]);
    };

    let timer: number | undefined;
    const play = el('button', {
      type: 'button',
      class: 'icon',
      text: '\u25B6\uFE0E',
      title: 'Play / pause animation',
      onclick: () => {
        if (timer !== undefined) {
          clearInterval(timer);
          a.timers.delete(timer);
          timer = undefined;
          play.textContent = '\u25B6\uFE0E';
          return;
        }
        timer = window.setInterval(() => step(1), PLAY_INTERVAL_MS);
        a.timers.add(timer);
        play.textContent = '\u275A\u275A';
      },
    });

    const controls =
      values.length > 1
        ? [iconButton('‹', 'Previous value', () => step(-1)), play, iconButton('›', 'Next value', () => step(1))]
        : [];

    return el(
      'div',
      { class: 'dimension' },
      el('div', { class: 'dim-label' }, el('strong', { text: name }), el('small', { text: info })),
      indexed ?? null,
      el('div', { class: 'dim-row' }, ...controls, text),
    );
  }
}
