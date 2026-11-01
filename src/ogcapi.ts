import { fetchChecked, upgradeToPageProtocol } from './http';
import {
  toWebMercator,
  type TileDataType,
  type WmtsCapabilities,
  type WmtsDimension,
  type WmtsLayer,
  type WmtsResourceUrl,
  type WmtsTileMatrix,
  type WmtsTileMatrixLimits,
  type WmtsTileMatrixSet,
} from './wmts';

const REL = 'http://www.opengis.net/def/rel/ogc/1.0/';
const MAX_COLLECTION_PAGES = 20;
const MVT_TYPE = 'application/vnd.mapbox-vector-tile';
const MVT_RE = /mapbox-vector-tile|protobuf/i;
const IMAGE_RE = /^image\/(png|jpe?g|webp|gif|avif)\b/i;
const WEB_MERCATOR_CRS_RE = /EPSG(?:\/[\d.]+\/|::?|\/)(?:3857|900913|3785|102100|102113)$/i;
const DATETIME_CONF_RE = /\/ogcapi-tiles-1\/[\d.]+\/conf\/datetime$/;
const WEB_MERCATOR_QUAD = 'WebMercatorQuad';

interface Link {
  href: string;
  rel: string;
  type?: string;
}
type Json = Record<string, unknown>;
interface Doc {
  doc: Json;
  /** Final URL of the document, the base for relative links. */
  url: string;
}

class NotJsonError extends Error {}

const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const objects = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isObject) : []);

function linksOf(doc: Json): Link[] {
  return objects(doc.links).filter((l): l is Json & Link => typeof l.href === 'string' && typeof l.rel === 'string');
}

const relIs = (l: Link, name: string) => l.rel === name || l.rel === REL + name;

/** Picks the JSON flavour of a relation; links without a type are assumed to negotiate JSON. */
function jsonLink(links: Link[], rel: string): Link | undefined {
  const candidates = links.filter((l) => relIs(l, rel));
  return (
    candidates.find((l) => l.type === 'application/json') ??
    candidates.find((l) => !l.type) ??
    candidates.find((l) => /json/i.test(l.type!) && !/tilejson|ld\+json/i.test(l.type!))
  );
}

/** Resolves a link against its document, keeping URI template variables intact. */
function absolute(href: string, base: string): string {
  return upgradeToPageProtocol(new URL(href, base)).href.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
}

function lastSegment(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try {
    const segment = new URL(href, base).pathname.split('/').filter(Boolean).pop();
    return segment ? decodeURIComponent(segment) : undefined;
  } catch {
    return undefined;
  }
}

function plainText(html: string | undefined): string | undefined {
  if (!html) return undefined;
  return new DOMParser().parseFromString(html, 'text/html').body.textContent?.trim() || undefined;
}

function crsUri(v: unknown): string | undefined {
  return str(v) ?? (isObject(v) ? str(v.uri) : undefined);
}

const isWebMercatorCrs = (crs: string) => WEB_MERCATOR_CRS_RE.test(crs.trim());

class Client {
  private docs = new Map<string, Promise<Doc>>();

  constructor(private extraParams: URLSearchParams) {}

  get(url: string): Promise<Doc> {
    let doc = this.docs.get(url);
    if (!doc) {
      doc = this.load(url);
      this.docs.set(url, doc);
      doc.catch(() => this.docs.delete(url));
    }
    return doc;
  }

  private async load(href: string): Promise<Doc> {
    const url = upgradeToPageProtocol(new URL(href));
    this.extraParams.forEach((v, k) => url.searchParams.set(k, v));
    const init = { headers: { Accept: 'application/json' } };
    let res = await fetchChecked(url.href, init);
    // Some servers ignore the Accept header and need the f parameter.
    if (/html/i.test(res.headers.get('content-type') ?? '') && !url.searchParams.has('f')) {
      url.searchParams.set('f', 'json');
      res = await fetchChecked(url.href, init);
    }
    let doc: unknown;
    try {
      doc = JSON.parse(await res.text());
    } catch {
      throw new NotJsonError(`${url.href} did not return JSON.`);
    }
    if (!isObject(doc)) throw new NotJsonError(`${url.href} did not return a JSON object.`);
    return { doc, url: res.url || url.href };
  }
}

function webMercatorQuad(identifier: string): WmtsTileMatrixSet {
  const matrices: WmtsTileMatrix[] = Array.from({ length: 25 }, (_, z) => ({
    identifier: String(z),
    scaleDenominator: 559082264.0287178 / 2 ** z,
    topLeft: [-20037508.3427892, 20037508.3427892],
    tileWidth: 256,
    tileHeight: 256,
  }));
  return { identifier, crs: 'http://www.opengis.net/def/crs/EPSG/0/3857', matrices, webMercator: toWebMercator(matrices) };
}

/** Parses OGC Two Dimensional Tile Matrix Set JSON, version 2.0 as well as the older 1.0 encoding. */
function parseTileMatrixSet(doc: Json, identifier: string): WmtsTileMatrixSet {
  const crs = crsUri(doc.crs) ?? str(doc.supportedCRS);
  const matrices = objects(doc.tileMatrices ?? doc.tileMatrix)
    .filter((m) => m.cornerOfOrigin === undefined || m.cornerOfOrigin === 'topLeft')
    .map((m): WmtsTileMatrix => {
      const origin = (Array.isArray(m.pointOfOrigin) ? m.pointOfOrigin : m.topLeftCorner) as unknown[] | undefined;
      return {
        identifier: str(m.id) ?? str(m.identifier) ?? '',
        scaleDenominator: Number(m.scaleDenominator),
        topLeft: [Number(origin?.[0]), Number(origin?.[1])],
        tileWidth: Number(m.tileWidth),
        tileHeight: Number(m.tileHeight),
      };
    });
  const webMercator = crs && !isWebMercatorCrs(crs) ? null : toWebMercator(matrices);
  return { identifier, crs, matrices, webMercator };
}

function parseLimits(v: unknown): Map<string, WmtsTileMatrixLimits> | undefined {
  const limits = objects(v);
  if (!limits.length) return undefined;
  return new Map(
    limits.map((l) => [
      String(l.tileMatrix ?? ''),
      {
        minRow: Number(l.minTileRow),
        maxRow: Number(l.maxTileRow),
        minCol: Number(l.minTileCol),
        maxCol: Number(l.maxTileCol),
      },
    ]),
  );
}

function guessFormat(href: string, dataType: TileDataType): string {
  const ext = /(?:\.|[?&]f=)(png|jpe?g|webp|mvt|pbf)\b/i.exec(href)?.[1].toLowerCase();
  if (ext === 'mvt' || ext === 'pbf') return MVT_TYPE;
  if (ext) return `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  return dataType === 'vector' ? MVT_TYPE : 'image/png';
}

/** Tile URI templates (rel="item") in a format MapLibre can render. */
function tileTemplates(links: Link[], base: string, dataType: TileDataType): { format: string; template: string }[] {
  const seen = new Set<string>();
  return links
    .filter((l) => l.rel === 'item')
    .map((l) => ({ format: l.type ?? guessFormat(l.href, dataType), template: absolute(l.href, base) }))
    .filter(
      (t) =>
        (dataType === 'vector' ? MVT_RE.test(t.format) : IMAGE_RE.test(t.format)) &&
        ['tileMatrix', 'tileRow', 'tileCol'].every((v) => new RegExp(`\\{${v}\\}`, 'i').test(t.template)) &&
        !seen.has(t.format) &&
        !!seen.add(t.format),
    );
}

interface ResolvedTileset {
  tms: WmtsTileMatrixSet;
  resources: WmtsResourceUrl[];
  limits?: Map<string, WmtsTileMatrixLimits>;
  vectorLayers: string[];
}

interface LayerSource {
  identifier: string;
  title: string;
  abstract?: string;
  doc: Json;
  dataType: TileDataType;
  tilesetsUrl: string;
  /** Collection (geodata) tile sets; servers tend to reject datetime on dataset tile sets. */
  isCollection: boolean;
}

class OgcApiLoader {
  private tileMatrixSets = new Map<string, Promise<WmtsTileMatrixSet | undefined>>();

  constructor(
    private client: Client,
    private caps: WmtsCapabilities,
    private datetime: boolean,
  ) {}

  createLayer(src: LayerSource): WmtsLayer {
    const layer: WmtsLayer = {
      identifier: src.identifier,
      title: src.title,
      abstract: src.abstract,
      bbox: extentBbox(src.doc),
      styles: [],
      formats: [],
      dimensions: this.datetime && src.isCollection ? temporalDimension(src.doc) : [],
      tileMatrixSets: [],
      tileMatrixLimits: {},
      resourceUrls: [],
      dataType: src.dataType,
      attribution: plainText(str(src.doc.attribution)),
      dimensionsAsQuery: true,
    };
    let pending: Promise<void> | undefined;
    layer.resolve = () => {
      pending ??= this.resolveLayer(layer, src.tilesetsUrl).then(
        () => (layer.resolve = undefined),
        (e: unknown) => {
          pending = undefined;
          throw e;
        },
      );
      return pending;
    };
    return layer;
  }

  private async resolveLayer(layer: WmtsLayer, tilesetsUrl: string): Promise<void> {
    const { doc, url } = await this.client.get(tilesetsUrl);
    const listLinks = linksOf(doc);
    const resolved = await Promise.all(
      objects(doc.tilesets).map((ts) => this.resolveTileset(ts, url, listLinks, layer.dataType).catch(() => undefined)),
    );
    const unsupported: string[] = [];
    const vectorLayers = new Set<string>();
    for (const r of resolved) {
      if (!r) continue;
      if (!r.tms.webMercator || !r.resources.length) {
        unsupported.push(r.tms.identifier);
        continue;
      }
      if (layer.tileMatrixSets.includes(r.tms.identifier)) continue;
      layer.tileMatrixSets.push(r.tms.identifier);
      layer.resourceUrls.push(...r.resources);
      if (r.limits) layer.tileMatrixLimits[r.tms.identifier] = r.limits;
      r.vectorLayers.forEach((v) => vectorLayers.add(v));
    }
    layer.vectorLayers = [...vectorLayers];
    if (!layer.tileMatrixSets.length) {
      layer.unavailableReason = resolved.length
        ? `No Web Mercator tile set in a supported format. Available: ${unsupported.join(', ') || 'none'}`
        : 'The server did not list any tile sets.';
    }
  }

  private async resolveTileset(
    ts: Json,
    base: string,
    listLinks: Link[],
    dataType: TileDataType,
  ): Promise<ResolvedTileset | undefined> {
    const tms = await this.tileMatrixSet(ts, base);
    if (!tms) return undefined;
    const result: ResolvedTileset = { tms, resources: [], vectorLayers: [] };
    if (!tms.webMercator) return result;

    const links = linksOf(ts);
    let meta = ts;
    let templates = tileTemplates(links, base, dataType);
    const self = jsonLink(links, 'self');
    const incomplete =
      !templates.length || !Array.isArray(ts.tileMatrixSetLimits) || (dataType === 'vector' && !Array.isArray(ts.layers));
    // Tile set lists may omit the tile templates and details, which are in the tile set metadata.
    if (incomplete && self) {
      try {
        const m = await this.client.get(absolute(self.href, base));
        meta = { ...ts, ...m.doc };
        if (!templates.length) templates = tileTemplates(linksOf(m.doc), m.url, dataType);
      } catch {
        // Fall back to what the list provides.
      }
    }
    if (!templates.length) templates = tileTemplates(listLinks, base, dataType);

    result.resources = templates.map((t) => ({
      format: t.format,
      resourceType: 'tile',
      template: t.template.replace(/\{tileMatrixSetId\}/gi, encodeURIComponent(tms.identifier)),
      tileMatrixSet: tms.identifier,
    }));
    result.limits = parseLimits(meta.tileMatrixSetLimits);
    result.vectorLayers = objects(meta.layers)
      .map((l) => str(l.id))
      .filter((id): id is string => !!id);
    return result;
  }

  private tileMatrixSet(ts: Json, base: string): Promise<WmtsTileMatrixSet | undefined> {
    const schemeLink = linksOf(ts).find((l) => relIs(l, 'tiling-scheme') && (!l.type || /json/i.test(l.type)));
    const uri = str(ts.tileMatrixSetURI);
    const id = str(ts.tileMatrixSetId) ?? lastSegment(schemeLink?.href, base) ?? lastSegment(uri, base);
    if (!id) return Promise.resolve(undefined);
    let tms = this.tileMatrixSets.get(id);
    if (!tms) {
      tms = this.loadTileMatrixSet(id, ts, uri, schemeLink && absolute(schemeLink.href, base));
      this.tileMatrixSets.set(id, tms);
    }
    return tms.then((t) => {
      if (t) this.caps.tileMatrixSets.set(t.identifier, t);
      return t;
    });
  }

  private async loadTileMatrixSet(
    id: string,
    ts: Json,
    uri: string | undefined,
    schemeUrl: string | undefined,
  ): Promise<WmtsTileMatrixSet | undefined> {
    if (id === WEB_MERCATOR_QUAD || uri?.endsWith(`/${WEB_MERCATOR_QUAD}`)) return webMercatorQuad(id);
    // No need to fetch the definition of a tile matrix set in another CRS.
    const crs = crsUri(ts.crs);
    if (crs && !isWebMercatorCrs(crs)) return { identifier: id, crs, matrices: [], webMercator: null };
    if (isObject(ts.tileMatrixSet)) return parseTileMatrixSet(ts.tileMatrixSet, id);
    if (!schemeUrl) return undefined;
    try {
      return parseTileMatrixSet((await this.client.get(schemeUrl)).doc, id);
    } catch {
      return undefined;
    }
  }
}

function extentBbox(doc: Json): WmtsLayer['bbox'] {
  const spatial = isObject(doc.extent) && isObject(doc.extent.spatial) ? doc.extent.spatial : undefined;
  const crs = crsUri(spatial?.crs);
  if (crs && !/CRS84h?$/i.test(crs)) return undefined;
  const b = Array.isArray(spatial?.bbox) ? spatial.bbox[0] : undefined;
  if (!Array.isArray(b)) return undefined;
  const n = b.map(Number);
  const bbox = (n.length === 6 ? [n[0], n[1], n[3], n[4]] : n.slice(0, 4)) as [number, number, number, number];
  return bbox.length === 4 && bbox.every(Number.isFinite) ? bbox : undefined;
}

/** OGC API – Tiles servers that conform to the datetime class accept a `datetime` query parameter. */
function temporalDimension(doc: Json): WmtsDimension[] {
  const temporal = isObject(doc.extent) && isObject(doc.extent.temporal) ? doc.extent.temporal : undefined;
  if (!temporal) return [];
  const interval = Array.isArray(temporal.interval) && Array.isArray(temporal.interval[0]) ? temporal.interval[0] : [];
  return [
    {
      identifier: 'datetime',
      title: 'Date / time',
      // Empty means the parameter is not sent, so the server applies its own default.
      default: '',
      current: false,
      values: interval.map(str).filter((v): v is string => !!v && v !== '..'),
    },
  ];
}

async function fetchConformance(client: Client, landing: Doc): Promise<string[]> {
  const fromDoc = (d: Json) => (Array.isArray(d.conformsTo) ? d.conformsTo.filter((c) => typeof c === 'string') : []);
  const link = jsonLink(linksOf(landing.doc), 'conformance');
  if (!link) return fromDoc(landing.doc);
  try {
    return fromDoc((await client.get(absolute(link.href, landing.url))).doc);
  } catch {
    return fromDoc(landing.doc);
  }
}

/** Collections with the URL of the page that listed them, the base for their relative links. */
async function fetchCollections(client: Client, first: string): Promise<Doc[]> {
  const out: Doc[] = [];
  let next: string | undefined = first;
  for (let page = 0; next && page < MAX_COLLECTION_PAGES; page++) {
    const { doc, url }: Doc = await client.get(next);
    out.push(...objects(doc.collections).map((c) => ({ doc: c, url })));
    const link = jsonLink(linksOf(doc), 'next');
    next = link ? absolute(link.href, url) : undefined;
  }
  return out;
}

function tilesetsUrls(doc: Doc): { dataType: TileDataType; url: string }[] {
  const links = linksOf(doc.doc);
  return (['map', 'vector'] as const).flatMap((dataType) => {
    const link = jsonLink(links, `tilesets-${dataType}`);
    return link ? [{ dataType, url: absolute(link.href, doc.url) }] : [];
  });
}

/**
 * Loads an OGC API landing page (or a collections list, or a single collection) and lists every
 * map and vector tile set as a layer. Resolves to undefined when the URL is not an OGC API resource.
 */
export async function loadOgcApi(input: string, extraParams: URLSearchParams): Promise<WmtsCapabilities | undefined> {
  const client = new Client(extraParams);
  let landing: Doc;
  try {
    landing = await client.get(new URL(input.trim(), location.href).href);
  } catch {
    return undefined;
  }
  const { doc } = landing;
  const isCollectionList = Array.isArray(doc.collections);
  if (!isCollectionList && !Array.isArray(doc.links)) return undefined;

  const title = str(doc.title) ?? new URL(landing.url).hostname;
  const caps: WmtsCapabilities = {
    kind: 'OGC API – Tiles',
    url: landing.url,
    extraParams,
    title,
    abstract: plainText(str(doc.description)),
    providerName: plainText(str(doc.attribution)),
    layers: [],
    tileMatrixSets: new Map(),
  };
  const conformance = await fetchConformance(client, landing);
  const loader = new OgcApiLoader(client, caps, conformance.some((c) => DATETIME_CONF_RE.test(c)));

  const dataLink = jsonLink(linksOf(doc), 'data');
  const isLanding = !!dataLink || isCollectionList;
  for (const { dataType, url } of tilesetsUrls(landing)) {
    const identifier = str(doc.id) ?? new URL(landing.url).pathname;
    caps.layers.push(
      loader.createLayer({
        identifier,
        title: isLanding ? `${title} (all collections)` : title,
        abstract: caps.abstract,
        doc,
        dataType,
        tilesetsUrl: url,
        isCollection: !isLanding,
      }),
    );
  }

  const collectionsUrl = isCollectionList ? landing.url : dataLink && absolute(dataLink.href, landing.url);
  if (collectionsUrl) {
    for (const collection of await fetchCollections(client, collectionsUrl)) {
      const c = collection.doc;
      const identifier = str(c.id) ?? '';
      for (const { dataType, url } of tilesetsUrls(collection)) {
        caps.layers.push(
          loader.createLayer({
            identifier,
            title: str(c.title) ?? identifier,
            abstract: plainText(str(c.description)),
            doc: c,
            dataType,
            tilesetsUrl: url,
            isCollection: true,
          }),
        );
      }
    }
  }

  if (!caps.layers.length) throw new Error('This OGC API does not offer any map or vector tiles.');
  return caps;
}
