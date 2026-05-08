import { readFile } from "node:fs/promises";

export async function loadEnvFile(envPath) {
  let text = "";
  try {
    text = await readFile(envPath, "utf8");
  } catch {
    return { loaded: false, path: envPath };
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq < 0) continue;

    const key = line.slice(0, eq).trim();
    if (!key || /[^A-Z0-9_]/i.test(key)) continue;
    if (process.env[key] !== undefined) continue;

    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }

  return { loaded: true, path: envPath };
}
