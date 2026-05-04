export function parseCsv(text) {
  const rows = [];
  let current = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];

    if (character === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (character === "," && !inQuotes) {
      current.push(cell);
      cell = "";
      continue;
    }

    if ((character === "\n" || character === "\r") && !inQuotes) {
      if (character === "\r" && next === "\n") {
        index += 1;
      }

      current.push(cell);
      if (current.some((value) => value.trim() !== "")) {
        rows.push(current);
      }
      current = [];
      cell = "";
      continue;
    }

    cell += character;
  }

  current.push(cell);
  if (current.some((value) => value.trim() !== "")) {
    rows.push(current);
  }

  if (rows.length === 0) {
    return [];
  }

  const [headerRow, ...dataRows] = rows;
  const headers = headerRow.map((value, index) => normalizeHeader(value) || `column_${index + 1}`);

  return dataRows.map((row) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = (row[index] ?? "").trim();
    });
    return record;
  });
}

export function stringifyCsv(records, preferredOrder = []) {
  if (!records.length) {
    return "";
  }

  const discovered = new Set(preferredOrder);
  for (const record of records) {
    for (const key of Object.keys(record)) {
      discovered.add(key);
    }
  }

  const headers = Array.from(discovered);
  const lines = [headers.map(escapeCsvCell).join(",")];

  for (const record of records) {
    const row = headers.map((header) => escapeCsvCell(record[header] ?? ""));
    lines.push(row.join(","));
  }

  return `${lines.join("\n")}\n`;
}

function normalizeHeader(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}
