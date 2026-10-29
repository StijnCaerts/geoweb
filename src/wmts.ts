const XLINK_NS = 'http://www.w3.org/1999/xlink';
const WORLD_SIZE = 40075016.68557849; // EPSG:3857 extent width in metres
const HALF_WORLD = WORLD_SIZE / 2;
const PIXEL_SIZE = 0.00028; // OGC standardized rendering pixel size in metres

export interface WmtsStyle {
  identifier: string;
  title: string;
  isDefault: boolean;
  legendUrl?: string;
}

export interface WmtsDimension {
  identifier: string;
  title?: string;
  uom?: string;
  default?: string;
  current: boolean;
  values: string[];
}

export interface WmtsResourceUrl {
  format: string;
  resourceType: string;
  template: string;
}

export interface WmtsTileMatrixLimits {
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
}

export interface WmtsLayer {
  identifier: string;
  title: string;
  abstract?: string;
  bbox?: [number, number, number, number];
  styles: WmtsStyle[];
  formats: string[];
  dimensions: WmtsDimension[];
  tileMatrixSets: string[];
  /** Per tile matrix set, the tile ranges per TileMatrix identifier (when declared). */
  tileMatrixLimits: Record<string, Map<string, WmtsTileMatrixLimits>>;
  resourceUrls: WmtsResourceUrl[];
}

export interface WmtsTileMatrix {
  identifier: string;
  scaleDenominator: number;
  topLeft: [number, number];
  tileWidth: number;
  tileHeight: number;
}

export interface WebMercatorInfo {
  zoomToMatrix: Map<number, string>;
  minZoom: number;
  maxZoom: number;
  tileSize: number;
}

export interface WmtsTileMatrixSet {
  identifier: string;
  crs?: string;
  matrices: WmtsTileMatrix[];
  /** Mapping to MapLibre's XYZ scheme, or null when the set is not Web Mercator compatible. */
  webMercator: WebMercatorInfo | null;
}

export interface WmtsCapabilities {
  url: string;
  extraParams: URLSearchParams;
  title: string;
  abstract?: string;
  providerName?: string;
  providerSite?: string;
  layers: WmtsLayer[];
  tileMatrixSets: Map<string, WmtsTileMatrixSet>;
  /** GetTile KVP endpoint, when advertised in OperationsMetadata. */
  kvpUrl?: string;
}

function kids(parent: Element | undefined, name: string): Element[] {
  if (!parent) return [];
  return Array.from(parent.children).filter((c) => c.localName === name);
}

function kid(parent: Element | undefined, name: string): Element | undefined {
  return kids(parent, name)[0];
}

function txt(parent: Element | undefined, name: string): string | undefined {
  return kid(parent, name)?.textContent?.trim() || undefined;
}

function href(e: Element | undefined): string | undefined {
  if (!e) return undefined;
  return e.getAttributeNS(XLINK_NS, 'href') || e.getAttribute('xlink:href') || undefined;
}

function numbers(s: string | undefined): number[] {
  return (s ?? '').trim().split(/\s+/).map(Number);
}

/** Adds SERVICE/REQUEST parameters when the user enters a bare endpoint, plus any extra parameters. */
export function buildCapabilitiesUrl(input: string, extraParams: URLSearchParams): string {
  const url = new URL(input.trim(), location.href);
  const keys = [...url.searchParams.keys()].map((k) => k.toLowerCase());
  const looksLikeDocument = /\.xml$/i.test(url.pathname);
  if (!looksLikeDocument && !keys.includes('request')) {
    if (!keys.includes('service')) url.searchParams.set('SERVICE', 'WMTS');
    url.searchParams.set('REQUEST', 'GetCapabilities');
  }
  extraParams.forEach((v, k) => url.searchParams.set(k, v));
  return url.href;
}

export function parseCapabilities(xml: string, url: string, extraParams: URLSearchParams): WmtsCapabilities {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('The response is not valid XML.');
  }
  const root = doc.documentElement;
  if (root.localName === 'ExceptionReport') {
    const msg = Array.from(root.getElementsByTagNameNS('*', 'ExceptionText'))
      .map((e) => e.textContent?.trim())
      .filter(Boolean)
      .join('; ');
    throw new Error(`Service exception: ${msg || 'unknown error'}`);
  }
  if (root.localName !== 'Capabilities') {
    throw new Error(`Not a WMTS Capabilities document (root element <${root.localName}>).`);
  }

  const si = kid(root, 'ServiceIdentification');
  const sp = kid(root, 'ServiceProvider');
  const contents = kid(root, 'Contents');

  const tileMatrixSets = new Map<string, WmtsTileMatrixSet>();
  for (const tms of kids(contents, 'TileMatrixSet')) {
    const parsed = parseTileMatrixSet(tms);
    tileMatrixSets.set(parsed.identifier, parsed);
  }

  return {
    url,
    extraParams,
    title: txt(si, 'Title') ?? 'Untitled WMTS service',
    abstract: txt(si, 'Abstract'),
    providerName: txt(sp, 'ProviderName'),
    providerSite: href(kid(sp, 'ProviderSite')),
    layers: kids(contents, 'Layer').map(parseLayer),
    tileMatrixSets,
    kvpUrl: findKvpGetTileUrl(root),
  };
}

function findKvpGetTileUrl(root: Element): string | undefined {
  const ops = kids(kid(root, 'OperationsMetadata'), 'Operation');
  const getTile = ops.find((o) => o.getAttribute('name') === 'GetTile');
  if (!getTile) return undefined;
  for (const get of Array.from(getTile.getElementsByTagNameNS('*', 'Get'))) {
    const encodings = Array.from(get.getElementsByTagNameNS('*', 'Value')).map((v) =>
      (v.textContent ?? '').trim().toUpperCase(),
    );
    if (!encodings.length || encodings.includes('KVP')) return href(get);
  }
  return undefined;
}

function parseLayer(l: Element): WmtsLayer {
  const identifier = txt(l, 'Identifier') ?? '';
  const bboxEl = kid(l, 'WGS84BoundingBox');
  let bbox: WmtsLayer['bbox'];
  if (bboxEl) {
    const [w, s] = numbers(txt(bboxEl, 'LowerCorner'));
    const [e, n] = numbers(txt(bboxEl, 'UpperCorner'));
    if ([w, s, e, n].every(Number.isFinite)) bbox = [w, s, e, n];
  }
  return {
    identifier,
    title: txt(l, 'Title') ?? identifier,
    abstract: txt(l, 'Abstract'),
    bbox,
    styles: kids(l, 'Style').map((s) => {
      const id = txt(s, 'Identifier') ?? '';
      return {
        identifier: id,
        title: txt(s, 'Title') ?? id,
        isDefault: s.getAttribute('isDefault') === 'true',
        legendUrl: href(kid(s, 'LegendURL')),
      };
    }),
    formats: kids(l, 'Format').map((f) => (f.textContent ?? '').trim()).filter(Boolean),
    dimensions: kids(l, 'Dimension').map((d) => ({
      identifier: txt(d, 'Identifier') ?? '',
      title: txt(d, 'Title'),
      uom: txt(d, 'UOM'),
      default: txt(d, 'Default'),
      current: txt(d, 'Current') === 'true',
      values: kids(d, 'Value').map((v) => (v.textContent ?? '').trim()).filter(Boolean),
    })),
    tileMatrixSets: kids(l, 'TileMatrixSetLink')
      .map((link) => txt(link, 'TileMatrixSet'))
      .filter((s): s is string => !!s),
    tileMatrixLimits: parseLimits(l),
    resourceUrls: kids(l, 'ResourceURL').map((r) => ({
      format: r.getAttribute('format') ?? '',
      resourceType: r.getAttribute('resourceType') ?? '',
      template: r.getAttribute('template') ?? '',
    })),
  };
}

function parseLimits(l: Element): WmtsLayer['tileMatrixLimits'] {
  const result: WmtsLayer['tileMatrixLimits'] = {};
  for (const link of kids(l, 'TileMatrixSetLink')) {
    const tms = txt(link, 'TileMatrixSet');
    const limits = kids(kid(link, 'TileMatrixSetLimits'), 'TileMatrixLimits');
    if (!tms || !limits.length) continue;
    result[tms] = new Map(
      limits.map((m) => [
        txt(m, 'TileMatrix') ?? '',
        {
          minRow: Number(txt(m, 'MinTileRow')),
          maxRow: Number(txt(m, 'MaxTileRow')),
          minCol: Number(txt(m, 'MinTileCol')),
          maxCol: Number(txt(m, 'MaxTileCol')),
        },
      ]),
    );
  }
  return result;
}

function parseTileMatrixSet(tms: Element): WmtsTileMatrixSet {
  const matrices = kids(tms, 'TileMatrix').map((m) => {
    const [x, y] = numbers(txt(m, 'TopLeftCorner'));
    return {
      identifier: txt(m, 'Identifier') ?? '',
      scaleDenominator: Number(txt(m, 'ScaleDenominator')),
      topLeft: [x, y] as [number, number],
      tileWidth: Number(txt(m, 'TileWidth')),
      tileHeight: Number(txt(m, 'TileHeight')),
    };
  });
  return {
    identifier: txt(tms, 'Identifier') ?? '',
    crs: txt(tms, 'SupportedCRS'),
    matrices,
    webMercator: toWebMercator(matrices),
  };
}

/**
 * MapLibre only renders Web Mercator XYZ tiles. A tile matrix matches zoom level z when its
 * origin is the top-left corner of the Web Mercator world and one tile spans WORLD_SIZE / 2^z.
 */
function toWebMercator(matrices: WmtsTileMatrix[]): WebMercatorInfo | null {
  const zoomToMatrix = new Map<number, string>();
  let tileSize: number | undefined;
  for (const m of matrices) {
    if (m.tileWidth !== m.tileHeight || !(m.scaleDenominator > 0)) continue;
    if (tileSize !== undefined && m.tileWidth !== tileSize) continue;
    if (Math.abs(m.topLeft[0] + HALF_WORLD) > 1 || Math.abs(m.topLeft[1] - HALF_WORLD) > 1) continue;
    const zf = Math.log2(WORLD_SIZE / (m.tileWidth * m.scaleDenominator * PIXEL_SIZE));
    const z = Math.round(zf);
    if (Math.abs(zf - z) > 0.02 || z < 0 || z > 30 || zoomToMatrix.has(z)) continue;
    tileSize = m.tileWidth;
    zoomToMatrix.set(z, m.identifier);
  }
  if (!zoomToMatrix.size || tileSize === undefined) return null;
  const zooms = [...zoomToMatrix.keys()];
  return { zoomToMatrix, minZoom: Math.min(...zooms), maxZoom: Math.max(...zooms), tileSize };
}

export function compatibleMatrixSets(caps: WmtsCapabilities, layer: WmtsLayer): WmtsTileMatrixSet[] {
  return layer.tileMatrixSets
    .map((id) => caps.tileMatrixSets.get(id))
    .filter((t): t is WmtsTileMatrixSet => !!t?.webMercator);
}
