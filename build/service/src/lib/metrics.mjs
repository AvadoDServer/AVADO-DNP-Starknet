// Reads the Prometheus text format (the validator's /metrics page) into a
// plain {name: value} map. Labels are ignored; the last sample of a name wins.
export function parsePrometheus(text) {
  const out = {};
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)/.exec(line);
    if (!m) continue;
    const value = Number(m[3]);
    if (Number.isFinite(value)) out[m[1]] = value;
  }
  return out;
}
