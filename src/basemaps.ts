import type { StyleSpecification } from 'maplibre-gl';

export interface Basemap {
  id: string;
  label: string;
  group: string;
  style: string | StyleSpecification;
}

const BACKGROUND = { id: 'background', type: 'background', paint: { 'background-color': '#dfe3e8' } } as const;

const openFreeMap = (name: string, label: string): Basemap => ({
  id: `ofm-${name}`,
  label,
  group: 'OpenFreeMap (vector)',
  style: `https://tiles.openfreemap.org/styles/${name}`,
});

export const BASEMAPS: Basemap[] = [
  {
    id: 'osm',
    label: 'OpenStreetMap',
    group: 'Raster',
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
      layers: [BACKGROUND, { id: 'osm', type: 'raster', source: 'osm' }],
    },
  },
  openFreeMap('liberty', 'Liberty'),
  openFreeMap('bright', 'Bright'),
  openFreeMap('positron', 'Positron'),
  openFreeMap('dark', 'Dark'),
  openFreeMap('fiord', 'Fiord'),
  { id: 'none', label: 'None', group: 'Other', style: { version: 8, sources: {}, layers: [BACKGROUND] } },
];
