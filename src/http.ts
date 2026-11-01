/** Browsers block http requests from https pages; many servers advertise http but also serve https. */
export function upgradeToPageProtocol(url: URL): URL {
  if (location.protocol === 'https:' && url.protocol === 'http:') url.protocol = 'https:';
  return url;
}

/** Fetches a URL, turning network failures and HTTP errors into user friendly messages. */
export async function fetchChecked(url: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    const mixedContent = location.protocol === 'https:' && url.startsWith('http:');
    throw new Error(
      mixedContent
        ? 'The browser blocked this http:// URL because this page is served over https://. Use an https:// service URL.'
        : 'Could not reach the service. Check the URL, and note that the server must allow cross-origin requests (CORS).',
    );
  }
  if (!res.ok) throw new Error(`The server responded with HTTP ${res.status} ${res.statusText}.`);
  return res;
}
