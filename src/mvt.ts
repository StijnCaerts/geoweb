const decoder = new TextDecoder();

/**
 * Reads the layer names from a Mapbox Vector Tile without decoding features, so source layers
 * can be styled even when the server does not describe them. Tile.layers is field 3,
 * Layer.name is field 1 (see the vector-tile-spec protobuf schema).
 */
export function mvtLayerNames(data: ArrayBuffer): string[] {
  const b = new Uint8Array(data);
  const names: string[] = [];
  let p = 0;

  const varint = (): number => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (p >= b.length) throw new Error('Truncated varint');
      byte = b[p++];
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  };

  const skip = (wire: number): void => {
    if (wire === 0) varint();
    else if (wire === 1) p += 8;
    else if (wire === 2) p += varint();
    else if (wire === 5) p += 4;
    else throw new Error(`Unsupported wire type ${wire}`);
  };

  try {
    while (p < b.length) {
      const key = varint();
      if (key >>> 3 !== 3 || (key & 7) !== 2) {
        skip(key & 7);
        continue;
      }
      const end = p + varint();
      while (p < end) {
        const k = varint();
        if (k >>> 3 === 1 && (k & 7) === 2) {
          const len = varint();
          names.push(decoder.decode(b.subarray(p, p + len)));
          p += len;
        } else {
          skip(k & 7);
        }
      }
      p = end;
    }
  } catch {
    // Malformed tile: keep the names found so far, MapLibre reports the actual error.
  }
  return names;
}

/** Some servers send gzipped tiles without a Content-Encoding header, which MapLibre cannot parse. */
export async function gunzipIfNeeded(data: ArrayBuffer): Promise<ArrayBuffer> {
  const b = new Uint8Array(data, 0, Math.min(2, data.byteLength));
  if (b[0] !== 0x1f || b[1] !== 0x8b) return data;
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}
