import { el } from './dom';

export interface TileSample {
  layerKey: string;
  layerTitle: string;
  tileMatrixSet: string;
  tileMatrix: string;
  zoom: number;
  /** Time until response headers arrived, in ms. */
  ttfb: number;
  /** Time until the full body was received, in ms. */
  duration: number;
  bytes: number;
  /** HTTP status, or 0 for network/CORS failures. */
  status: number;
}

interface Aggregate {
  tileMatrixSet: string;
  tileMatrix: string;
  zoom: number;
  count: number;
  errors: number;
  durations: number[];
  ttfbs: number[];
  bytes: number;
}

const MAX_SAMPLES = 20000;
const RENDER_INTERVAL_MS = 500;
const ALL_LAYERS = '';

export class TileMonitor {
  enabled = false;
  private samples: TileSample[] = [];
  private listeners = new Set<() => void>();

  record(sample: TileSample): void {
    if (!this.enabled) return;
    this.samples.push(sample);
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);
    this.listeners.forEach((l) => l());
  }

  reset(): void {
    this.samples = [];
    this.listeners.forEach((l) => l());
  }

  get all(): readonly TileSample[] {
    return this.samples;
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }
}

/** Nearest-rank percentile of an ascending sorted list. */
function percentile(sorted: number[], q: number): number {
  return sorted.length ? sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] : NaN;
}

function aggregate(samples: readonly TileSample[]): Aggregate[] {
  const groups = new Map<string, Aggregate>();
  for (const s of samples) {
    const key = `${s.tileMatrixSet}\n${s.tileMatrix}`;
    let g = groups.get(key);
    if (!g) {
      g = { tileMatrixSet: s.tileMatrixSet, tileMatrix: s.tileMatrix, zoom: s.zoom, count: 0, errors: 0, durations: [], ttfbs: [], bytes: 0 };
      groups.set(key, g);
    }
    g.count++;
    g.bytes += s.bytes;
    if (s.status < 200 || s.status >= 300) g.errors++;
    else {
      g.durations.push(s.duration);
      g.ttfbs.push(s.ttfb);
    }
  }
  for (const g of groups.values()) {
    g.durations.sort((a, b) => a - b);
    g.ttfbs.sort((a, b) => a - b);
  }
  return [...groups.values()].sort((a, b) => a.tileMatrixSet.localeCompare(b.tileMatrixSet) || a.zoom - b.zoom);
}

const ms = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString() : '–');
const kb = (bytes: number, n: number) => (n ? (bytes / n / 1024).toFixed(1) : '–');
const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN);

export function mountMonitorPanel(toggle: HTMLInputElement, body: HTMLElement, monitor: TileMonitor): void {
  const layerSelect = el('select', { 'aria-label': 'Layer filter' });
  const summary = el('p', { class: 'small' });
  const tableWrap = el('div', { class: 'perf-table' });
  body.replaceChildren(
    el(
      'div',
      { class: 'row' },
      layerSelect,
      el('button', { type: 'button', class: 'secondary', text: 'Reset', onclick: () => monitor.reset() }),
    ),
    summary,
    tableWrap,
    el('p', {
      class: 'hint small',
      text:
        'Durations in ms (TTFB: median time until headers arrived; KB: average tile size). Measured in the browser, including queueing behind other requests. Cached tiles are not requested again; pan or zoom to collect samples.',
    }),
  );

  const render = () => {
    const samples = monitor.all;
    const layers = new Map(samples.map((s) => [s.layerKey, s.layerTitle]));
    const selected = layers.has(layerSelect.value) ? layerSelect.value : ALL_LAYERS;
    layerSelect.replaceChildren(
      el('option', { value: ALL_LAYERS, text: 'All layers' }),
      ...[...layers].map(([key, title]) => el('option', { value: key, text: title })),
    );
    layerSelect.value = selected;

    const filtered = selected === ALL_LAYERS ? samples : samples.filter((s) => s.layerKey === selected);
    if (!filtered.length) {
      summary.textContent = 'No tile requests recorded yet.';
      tableWrap.replaceChildren();
      return;
    }
    const ok = filtered.filter((s) => s.status >= 200 && s.status < 300);
    const sorted = ok.map((s) => s.duration).sort((a, b) => a - b);
    const errors = filtered.length - ok.length;
    const totalBytes = filtered.reduce((sum, s) => sum + s.bytes, 0);
    summary.textContent =
      `${filtered.length.toLocaleString()} requests · ${errors} errors (${((errors / filtered.length) * 100).toFixed(1)}%) · ` +
      `median ${ms(percentile(sorted, 0.5))} ms · p95 ${ms(percentile(sorted, 0.95))} ms · ` +
      `${(totalBytes / 1024 / 1024).toFixed(2)} MB`;

    const headers = ['Matrix', 'Req.', 'Err.', 'TTFB', 'p50', 'p95', 'Max', 'Avg', 'KB'];
    const groups = aggregate(filtered);
    const rows: HTMLTableRowElement[] = [];
    groups.forEach((g, i) => {
      if (g.tileMatrixSet !== groups[i - 1]?.tileMatrixSet) {
        rows.push(el('tr', { class: 'group' }, el('th', { colSpan: headers.length, text: g.tileMatrixSet })));
      }
      rows.push(
        el(
          'tr',
          { class: g.errors ? 'has-errors' : '' },
          ...[
            g.tileMatrix === String(g.zoom) ? g.tileMatrix : `${g.tileMatrix} (z${g.zoom})`,
            g.count.toLocaleString(),
            String(g.errors),
            ms(percentile(g.ttfbs, 0.5)),
            ms(percentile(g.durations, 0.5)),
            ms(percentile(g.durations, 0.95)),
            ms(g.durations[g.durations.length - 1] ?? NaN),
            ms(mean(g.durations)),
            kb(g.bytes, g.count - g.errors),
          ].map((v) => el('td', { text: v })),
        ),
      );
    });
    tableWrap.replaceChildren(
      el(
        'table',
        {},
        el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', { text: h })))),
        el('tbody', {}, ...rows),
      ),
    );
  };

  let timer: number | undefined;
  monitor.onChange(() => {
    if (timer === undefined) timer = window.setTimeout(() => ((timer = undefined), render()), RENDER_INTERVAL_MS);
  });
  layerSelect.addEventListener('change', render);
  toggle.addEventListener('change', () => {
    monitor.enabled = toggle.checked;
    body.hidden = !toggle.checked;
    render();
  });
  monitor.enabled = toggle.checked;
  body.hidden = !toggle.checked;
}
