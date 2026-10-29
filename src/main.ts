import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { BASEMAPS } from './basemaps';
import { el, safeHttpUrl } from './dom';
import { LAYER_PREFIX, LayerManager, SOURCE_PREFIX } from './layers';
import { loadSavedServices, storeSavedServices, type SavedService } from './saved';
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
const saveBtn = $<HTMLButtonElement>('save-btn');
const saveForm = $<HTMLFormElement>('save-form');
const saveName = $<HTMLInputElement>('save-name');
const savedSection = $<HTMLElement>('saved');
const savedList = $<HTMLUListElement>('saved-list');

// MapLibre resolves its worker next to its own module, which does not survive bundling.
maplibregl.setWorkerUrl(workerUrl);

const map = new maplibregl.Map({
  container: 'map',
  center: [0, 20],
  zoom: 1.5,
  style: BASEMAPS[0].style,
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');
map.addControl(new maplibregl.ScaleControl(), 'bottom-left');
/** Resolves when the current style can be modified; replaced on every basemap switch. */
let mapReady = new Promise<void>((resolve) => map.once('load', () => resolve()));
const layers = new LayerManager(map, $('active-layers'));

const basemapSelect = $<HTMLSelectElement>('basemap');
const globe = $<HTMLInputElement>('globe');
for (const group of new Set(BASEMAPS.map((b) => b.group))) {
  basemapSelect.append(
    el(
      'optgroup',
      { label: group },
      ...BASEMAPS.filter((b) => b.group === group).map((b) => el('option', { value: b.id, text: b.label })),
    ),
  );
}
basemapSelect.value = BASEMAPS[0].id;

basemapSelect.addEventListener('change', async () => {
  const basemap = BASEMAPS.find((b) => b.id === basemapSelect.value);
  if (!basemap) return;
  await mapReady;
  mapReady = new Promise<void>((resolve) => map.once('style.load', () => resolve()));
  map.setStyle(basemap.style, {
    diff: false,
    // Replacing the style drops everything, so carry the WMTS overlays and projection over.
    transformStyle: (previous, next) => {
      if (!previous) return next;
      const sources = { ...next.sources };
      for (const [id, source] of Object.entries(previous.sources)) {
        if (id.startsWith(SOURCE_PREFIX)) sources[id] = source;
      }
      return {
        ...next,
        sources,
        layers: [...next.layers, ...previous.layers.filter((l) => l.id.startsWith(LAYER_PREFIX))],
        projection: { type: globe.checked ? 'globe' : 'mercator' },
      };
    },
  });
});
globe.addEventListener('change', async () => {
  await mapReady;
  map.setProjection({ type: globe.checked ? 'globe' : 'mercator' });
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

let savedServices = loadSavedServices();

function persistSaved(next: SavedService[]): boolean {
  try {
    storeSavedServices(next);
  } catch {
    setStatus('Could not save: local storage is unavailable or full in this browser.', 'error');
    return false;
  }
  savedServices = next;
  renderSaved();
  return true;
}

function renderSaved() {
  savedSection.hidden = savedServices.length === 0;
  savedList.replaceChildren(
    ...savedServices.map((s, i) =>
      el(
        'li',
        { class: 'saved-item' },
        el(
          'button',
          {
            type: 'button',
            class: 'link saved-name',
            title: s.url,
            onclick: () => {
              urlInput.value = s.url;
              extraInput.value = s.params;
              void loadService(s.url, s.params);
            },
          },
          el('strong', { text: s.name }),
          el('small', { text: s.url }),
        ),
        el('button', {
          type: 'button',
          class: 'icon',
          text: '✕',
          title: `Remove "${s.name}"`,
          'aria-label': `Remove ${s.name}`,
          onclick: (e: Event) => {
            const btn = e.currentTarget as HTMLButtonElement;
            // Two clicks are required to remove, as a lightweight confirmation.
            if (btn.dataset.armed) {
              persistSaved(savedServices.filter((_, j) => j !== i));
              return;
            }
            btn.dataset.armed = 'true';
            btn.textContent = 'Remove?';
            setTimeout(() => {
              delete btn.dataset.armed;
              btn.textContent = '✕';
            }, 3000);
          },
        }),
      ),
    ),
  );
}

saveBtn.addEventListener('click', () => {
  const url = urlInput.value.trim();
  if (!url || !urlInput.checkValidity()) {
    setStatus('Enter a valid service URL before saving.', 'error');
    return;
  }
  const existing = savedServices.find((s) => s.url === url && s.params === extraInput.value.trim());
  const loadedTitle = caps && caps.url.startsWith(url.split('?')[0]) ? caps.title : undefined;
  saveName.value = existing?.name ?? loadedTitle ?? new URL(url).hostname;
  saveForm.hidden = false;
  saveName.select();
});

$<HTMLButtonElement>('save-cancel').addEventListener('click', () => (saveForm.hidden = true));

saveForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = saveName.value.trim();
  const url = urlInput.value.trim();
  const params = extraInput.value.trim();
  if (!name || !url) return;
  const existing = savedServices.find((s) => s.url === url && s.params === params);
  const next = existing
    ? savedServices.map((s) => (s === existing ? { ...s, name } : s))
    : [...savedServices, { name, url, params }];
  if (persistSaved(next)) {
    saveForm.hidden = true;
    setStatus(`Saved "${name}" in this browser.`, 'ok');
  }
});

renderSaved();

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
