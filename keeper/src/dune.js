const DUNE_QUERY_ID = Number(process.env.DUNE_QUERY_ID || "5839788");
const DUNE_API = "https://api.dune.com/api/v1";

function parseTime(s) {
  const t = Date.parse(String(s).replace(" UTC", "Z"));
  if (Number.isNaN(t)) throw new Error(`bad block_time: ${s}`);
  return t;
}

function inRange(ms, startIso, endIso) {
  const start = Date.parse(`${startIso}T00:00:00.000Z`);
  const end = Date.parse(`${endIso}T23:59:59.999Z`);
  return ms >= start && ms <= end;
}

function weekRange(now = Date.now()) {
  const d = new Date(now);
  const day = d.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + mondayOffset));
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const fmt = (x) => x.toISOString().slice(0, 10);
  return { start: fmt(monday), end: fmt(sunday) };
}

export async function fetchRenewers({ apiKey, epochMode, epochStart, epochEnd }) {
  const headers = { "x-dune-api-key": apiKey };
  const rows = [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    const url = `${DUNE_API}/query/${DUNE_QUERY_ID}/results?limit=${limit}&offset=${offset}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`dune ${res.status}: ${await res.text()}`);
    const body = await res.json();
    const batch = body.result?.rows || [];
    rows.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }

  let start = epochStart;
  let end = epochEnd;
  if (epochMode === "weekly") {
    const w = weekRange();
    start = w.start;
    end = w.end;
  }

  const members = new Set();
  for (const row of rows) {
    if (!row.is_renewal) continue;
    const ms = parseTime(row.block_time);
    if (!inRange(ms, start, end)) continue;
    const m = String(row.member || "").toLowerCase();
    if (/^0x[a-f0-9]{40}$/.test(m)) members.add(m);
  }

  return {
    wallets: [...members],
    window: { start, end },
    totalRows: rows.length,
  };
}
