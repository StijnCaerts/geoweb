export interface SavedService {
  name: string;
  url: string;
  /** Extra query parameters, e.g. API keys. */
  params: string;
}

const STORAGE_KEY = 'wmts-explorer:saved-services';

function isSavedService(v: unknown): v is SavedService {
  const s = v as SavedService;
  return !!s && typeof s.name === 'string' && typeof s.url === 'string' && typeof s.params === 'string';
}

export function loadSavedServices(): SavedService[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isSavedService) : [];
  } catch {
    return [];
  }
}

/** Throws when storage is unavailable or full. */
export function storeSavedServices(services: SavedService[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(services));
}
