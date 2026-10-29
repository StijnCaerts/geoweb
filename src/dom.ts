type Child = Node | string | null | undefined | false;
type Props = Record<string, unknown>;

/** Small DOM builder. Text is always inserted via text nodes, never as HTML. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = String(v);
    else if (k === 'text') e.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v as EventListener);
    else if (k in e) (e as unknown as Record<string, unknown>)[k] = v;
    else e.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Returns the URL only when it uses http(s), to avoid javascript: and similar URLs from untrusted documents. */
export function safeHttpUrl(s: string | undefined): string | undefined {
  if (!s) return undefined;
  try {
    const u = new URL(s, location.href);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

export function select(options: { value: string; label: string }[], value: string, onChange: (v: string) => void) {
  const s = el('select', { onchange: () => onChange(s.value) });
  for (const o of options) s.append(el('option', { value: o.value, text: o.label }));
  s.value = value;
  return s;
}
