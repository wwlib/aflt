// aflt space selection for the af sessions panel. Pure helpers (no herdr /
// gpui-kit imports) so the node test suite can load this file directly.
//
// "aflt space" = a named AgentFleet home under ~/.agentfleet/spaces/<name>.
// Not to be confused with Herdr's own spaces() (app workspaces).

/** localStorage key for the picked aflt space ("" / missing = default). */
export const AFLT_SPACE_KEY = "afltSpace";

/** Same rule as aflt's validateSpaceName (lib/util.js). */
const SPACE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Normalize a stored/picked value: null means the default (no-space) home. */
export function normalizeAfltSpace(name) {
  if (name == null) return null;
  const s = String(name).trim();
  if (!s || s === "default" || s === "(default)") return null;
  if (s.includes("..") || !SPACE_NAME_RE.test(s)) return null;
  return s;
}

/** Label for the header / picker. */
export function afltSpaceLabel(name) {
  return normalizeAfltSpace(name) || "default";
}

/** `--space <name>` for a named space; nothing for the default home. */
export function afltSpaceArgs(name) {
  const s = normalizeAfltSpace(name);
  return s ? ["--space", s] : [];
}

/** Prefix an aflt argv with the space selection (aflt accepts --space anywhere). */
export function withAfltSpace(args, name) {
  return [...afltSpaceArgs(name), ...(args || [])];
}

/**
 * Parse `aflt space ls --json` ({ current, default, spaces: [{ name }] }).
 * Returns { names: string[] (sorted, valid only), error: string | null }.
 */
export function parseAfltSpaceList(text) {
  let data;
  try {
    data = JSON.parse(String(text || ""));
  } catch (_) {
    return { names: [], error: "parse failed" };
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.spaces)) {
    return { names: [], error: "bad json" };
  }
  const names = [];
  for (const s of data.spaces) {
    const n = normalizeAfltSpace(s && s.name);
    if (n && !names.includes(n)) names.push(n);
  }
  names.sort((a, b) => a.localeCompare(b));
  return { names, error: null };
}

/** Picker options: default first, then every named space. */
export function afltSpaceOptions(names) {
  return [null, ...(names || []).map(normalizeAfltSpace).filter(Boolean)];
}

/**
 * Keep the selection only if it still exists.
 * Returns { space, missing } — missing=true means we fell back to default.
 */
export function resolveAfltSpace(selected, names) {
  const s = normalizeAfltSpace(selected);
  if (!s) return { space: null, missing: false };
  if ((names || []).includes(s)) return { space: s, missing: false };
  return { space: null, missing: true };
}

/** Read the saved selection from a Web Storage-like object (null on any error). */
export function loadAfltSpace(storage) {
  try {
    if (!storage || typeof storage.getItem !== "function") return null;
    return normalizeAfltSpace(storage.getItem(AFLT_SPACE_KEY));
  } catch (_) {
    return null;
  }
}

/** Save the selection ("" for default). Returns false when storage is unavailable. */
export function saveAfltSpace(storage, name) {
  try {
    if (!storage || typeof storage.setItem !== "function") return false;
    storage.setItem(AFLT_SPACE_KEY, normalizeAfltSpace(name) || "");
    return true;
  } catch (_) {
    return false;
  }
}
