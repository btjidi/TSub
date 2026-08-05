const HTTP_URL_RE = /^https?:\/\//i;

export const SUBSCRIPTION_IMPORT_MAX_BYTES = 1024 * 1024;
export const SUBSCRIPTION_IMPORT_MAX_ITEMS = 1000;

function cleanCell(value) {
  return String(value ?? '').replace(/^\uFEFF/, '').trim();
}

function isSubscriptionUrl(value) {
  const text = cleanCell(value);
  if (!HTTP_URL_RE.test(text)) return false;
  try {
    const parsed = new URL(text);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell);
      if (row.some(value => cleanCell(value))) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  if (quoted) throw new Error('invalid-csv');
  row.push(cell);
  if (row.some(value => cleanCell(value))) rows.push(row);
  return rows;
}

function rowsFromText(text) {
  return text.split(/\r?\n/).map(line => {
    const value = cleanCell(line);
    if (!value || value.startsWith('#')) return null;
    if (isSubscriptionUrl(value)) return { url: value, name: '' };

    for (const delimiter of ['|', ',']) {
      const index = value.indexOf(delimiter);
      if (index > 0) {
        const name = cleanCell(value.slice(0, index));
        const url = cleanCell(value.slice(index + 1));
        if (isSubscriptionUrl(url)) return { name, url };
      }
    }
    return { url: value, name: '' };
  }).filter(Boolean);
}

function rowsFromCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map(value => cleanCell(value).toLowerCase());
  const urlIndex = header.findIndex(value => ['url', 'link', 'subscription', '订阅链接', '链接'].includes(value));
  const nameIndex = header.findIndex(value => ['name', 'title', '名称', '订阅名称'].includes(value));
  const dataRows = urlIndex >= 0 ? rows.slice(1) : rows;

  return dataRows.map(row => {
    const resolvedUrlIndex = urlIndex >= 0 ? urlIndex : row.findIndex(isSubscriptionUrl);
    return {
      name: nameIndex >= 0 ? cleanCell(row[nameIndex]) : cleanCell(row.find((value, index) => index !== resolvedUrlIndex) || ''),
      url: cleanCell(row[resolvedUrlIndex] || '')
    };
  });
}

function rowsFromJson(text) {
  const parsed = JSON.parse(text);
  const records = Array.isArray(parsed) ? parsed : parsed?.subscriptions;
  if (!Array.isArray(records)) throw new Error('invalid-json-shape');
  return records.map(record => typeof record === 'string'
    ? { name: '', url: cleanCell(record) }
    : { name: cleanCell(record?.name || record?.title), url: cleanCell(record?.url || record?.link) });
}

export function parseSubscriptionFile(text, extension = 'txt', existingUrls = []) {
  const format = cleanCell(extension).toLowerCase().replace(/^\./, '');
  let rows;
  if (format === 'json') rows = rowsFromJson(text);
  else if (format === 'csv') rows = rowsFromCsv(text);
  else if (format === 'txt') rows = rowsFromText(text);
  else throw new Error('unsupported-format');

  const seen = new Set(existingUrls.map(cleanCell));
  const subscriptions = [];
  let invalid = 0;
  let duplicate = 0;

  for (const row of rows.slice(0, SUBSCRIPTION_IMPORT_MAX_ITEMS)) {
    if (!isSubscriptionUrl(row.url)) {
      invalid += 1;
      continue;
    }
    if (seen.has(row.url)) {
      duplicate += 1;
      continue;
    }
    seen.add(row.url);
    subscriptions.push({ name: cleanCell(row.name), url: row.url });
  }
  if (rows.length > SUBSCRIPTION_IMPORT_MAX_ITEMS) invalid += rows.length - SUBSCRIPTION_IMPORT_MAX_ITEMS;

  return { subscriptions, invalid, duplicate };
}
