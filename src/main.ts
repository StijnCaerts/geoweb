import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { el, safeHttpUrl } from './dom';
import { LayerManager } from './layers';
import { buildCapabilitiesUrl, compatibleMatrixSets, parseCapabilities, type WmtsCapabilities, type WmtsLayer } from './wmts';

const EXAMPLES = [
  {
    label: 'NASA GIBS – global satellite imagery (time)',
    url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?SERVICE=WMTS&REQUEST=GetCapabilities',
  },
  { label: 'swisstopo – Switzerland (time)', url: 'https://wmts.geo.admin.ch/EPSG/3857/1.0.0/WMTSCapabilities.xml' },
  { label: 'basemap.at – Austria', url: 'https://mapsneu.wien.gv.at/basemapneu/1.0.0/WMTSCapabilities.xml' },
  {
    label: 'PDOK BRT Achtergrondkaart – Netherlands',
    url: 'https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0?request=GetCapabilities&service=wmts',
  },
];
const MAX_LIST_ITEMS = 300;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>('service-form');
const urlInput = $<HTMLInputElement>('cap-url');
const extraInput = $<HTMLInputElement>('extra-params');
const loadBtn = $<HTMLButtonElement>('load-btn');
const examples = $<HTMLSelectElement>('examples');
const statusEl = $<HTMLParagraphElement>('status');
const serviceInfo = $<HTMLElement>('service-info');
const catalog = $<HTMLElement>('catalog');
const layerCount = $<HTMLElement>('layer-count');
const filterInput = $<HTMLInputElement>('layer-filter');
const onlyCompatible = $<HTMLInputElement>('only-compatible');
const layerList = $<HTMLUListElement>('layer-list');

// MapLibre resolves its worker next to its own module, which does not survive bundling.
maplibregl.setWorkerUrl(workerUrl);

const map = new maplibregl.Map({
  container: 'map',
  center: [0, 20],
  zoom: 1.5,
  style: {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#dfe3e8' } },
      { id: 'osm', type: 'raster', source: 'osm' },
    ],
  },
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');
map.addControl(new maplibregl.ScaleControl(), 'bottom-left');
const mapReady = new Promise<void>((resolve) => map.once('load', () => resolve()));
const layers = new LayerManager(map, $('active-layers'));

$<HTMLSelectElement>('basemap').addEventListener('change', async (e) => {
  await mapReady;
  const visible = (e.target as HTMLSelectElement).value === 'osm';
  map.setLayoutProperty('osm', 'visibility', visible ? 'visible' : 'none');
});
$<HTMLInputElement>('globe').addEventListener('change', async (e) => {
  await mapReady;
  map.setProjection({ type: (e.target as HTMLInputElement).checked ? 'globe' : 'mercator' });
});

function setStatus(message: string, kind: 'info' | 'ok' | 'error' = 'info') {
  statusEl.textContent = message;
  statusEl.className = `status ${kind}`;
  statusEl.hidden = false;
}

let caps: WmtsCapabilities | undefined;
let loadToken = 0;

async function loadService(input: string, extra: string) {
  const token = ++loadToken;
  const extraParams = new URLSearchParams(extra.trim().replace(/^[?&]/, ''));
  let url: string;
  try {
    url = buildCapabilitiesUrl(input, extraParams);
  } catch {
    setStatus('Please enter a valid URL.', 'error');
    return;
  }
  const mixedContent = location.protocol === 'https:' && url.startsWith('http:');

  setStatus('Loading capabilities…');
  loadBtn.disabled = true;
  try {
    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      throw new Error(
        mixedContent
          ? 'The browser blocked this http:// URL because this page is served over https://. Use an https:// service URL.'
          : 'Could not reach the service. Check the URL, and note that the server must allow cross-origin requests (CORS).',
      );
    }
    if (!res.ok) throw new Error(`The server responded with HTTP ${res.status} ${res.statusText}.`);
    const parsed = parseCapabilities(await res.text(), url, extraParams);
    if (token !== loadToken) return;

    caps = parsed;
    const compatible = parsed.layers.filter((l) => compatibleMatrixSets(parsed, l).length).length;
    setStatus(
      `Loaded ${parsed.layers.length} layers, ${compatible} of which can be displayed in Web Mercator.`,
      compatible ? 'ok' : 'error',
    );
    renderServiceInfo(parsed);
    filterInput.value = '';
    renderCatalog();

    const query = new URLSearchParams({ url: input.trim() });
    history.replaceState(null, '', `${location.pathname}?${query}`);
  } catch (e) {
    if (token === loadToken) setStatus(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    if (token === loadToken) loadBtn.disabled = false;
  }
}

function renderServiceInfo(c: WmtsCapabilities) {
  const site = safeHttpUrl(c.providerSite);
  serviceInfo.replaceChildren(
    ...[
      el('h2', { text: c.title }),
      c.providerName
        ? el(
            'p',
            { class: 'small' },
            'Provided by ',
            site ? el('a', { href: site, target: '_blank', rel: 'noopener', text: c.providerName }) : c.providerName,
          )
        : null,
      c.abstract ? el('details', {}, el('summary', { text: 'About this service' }), el('p', { text: c.abstract })) : null,
    ].filter((n) => n !== null),
  );
  serviceInfo.hidden = false;
}

function layerItem(c: WmtsCapabilities, l: WmtsLayer): HTMLLIElement {
  const sets = compatibleMatrixSets(c, l);
  const ok = sets.length > 0;
  const reason = ok
    ? undefined
    : `No Web Mercator compatible tile matrix set. Available: ${l.tileMatrixSets.join(', ') || 'none'}`;
  return el(
    'li',
    { class: ok ? 'layer-item' : 'layer-item disabled', title: reason ?? l.abstract?.slice(0, 400) ?? '' },
    el(
      'div',
      { class: 'layer-info' },
      el('strong', { text: l.title }),
      el('small', { text: l.identifier }),
      l.dimensions.length
        ? el('div', { class: 'badges' }, ...l.dimensions.map((d) => el('span', { class: 'badge', text: d.identifier })))
        : null,
    ),
    el('button', {
      type: 'button',
      text: 'Add',
      disabled: !ok,
      onclick: async () => {
        await mapReady;
        layers.add(c, l);
      },
    }),
  );
}

function renderCatalog() {
  if (!caps) return;
  const c = caps;
  const q = filterInput.value.trim().toLowerCase();
  const matches = c.layers.filter(
    (l) =>
      (!onlyCompatible.checked || compatibleMatrixSets(c, l).length > 0) &&
      (!q || l.title.toLowerCase().includes(q) || l.identifier.toLowerCase().includes(q)),
  );
  layerCount.textContent = `(${matches.length} of ${c.layers.length})`;
  const items: HTMLElement[] = matches.slice(0, MAX_LIST_ITEMS).map((l) => layerItem(c, l));
  if (matches.length > MAX_LIST_ITEMS) {
    items.push(
      el('li', { class: 'hint', text: `${matches.length - MAX_LIST_ITEMS} more layers – refine the filter to see them.` }),
    );
  }
  if (!matches.length) items.push(el('li', { class: 'hint', text: 'No matching layers.' }));
  layerList.replaceChildren(...items);
  catalog.hidden = false;
}

for (const ex of EXAMPLES) examples.append(el('option', { value: ex.url, text: ex.label }));
examples.addEventListener('change', () => {
  if (!examples.value) return;
  urlInput.value = examples.value;
  extraInput.value = '';
  examples.value = '';
  form.requestSubmit();
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  void loadService(urlInput.value, extraInput.value);
});

let filterTimer: number | undefined;
filterInput.addEventListener('input', () => {
  clearTimeout(filterTimer);
  filterTimer = window.setTimeout(renderCatalog, 150);
});
onlyCompatible.addEventListener('change', renderCatalog);

const initialUrl = new URLSearchParams(location.search).get('url');
if (initialUrl) {
  urlInput.value = initialUrl;
  void loadService(initialUrl, '');
}
