// api/room.js — Vercel Serverless Function
// GET  /api/room?code=XXXX                         → room state буцаана
// POST /api/room {action:'create', state:{...}}    → room үүсгэнэ
// POST /api/room {action:'update', code, patch:{}} → шинэчилнэ

const mem = {}; // in-memory fallback (same Vercel instance)

// ── Vercel KV REST API helpers ──────────────────────────────────────
// Vercel KV REST: uses Upstash-compatible REST protocol
async function kvGet(code) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/get/room:${code}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.result ? JSON.parse(j.result) : null;
  } catch (e) {
    console.error('[kvGet]', e.message);
    return null;
  }
}

async function kvSet(code, data) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  try {
    // Upstash REST: SET key value EX seconds
    const encoded = encodeURIComponent(JSON.stringify(data));
    const r = await fetch(`${url}/set/room:${code}/${encoded}/EX/86400`, {
      method: 'GET', // Upstash REST pipeline uses GET for commands
      headers: { Authorization: `Bearer ${token}` }
    });
    return r.ok;
  } catch (e) {
    console.error('[kvSet]', e.message);
    return false;
  }
}

async function getRoom(code) {
  const kv = await kvGet(code);
  if (kv) return kv;
  return mem[code] || null;
}

async function setRoom(code, data) {
  const ok = await kvSet(code, data);
  if (!ok) console.warn('[setRoom] KV unavailable, using mem fallback');
  mem[code] = data;
}

// ── Handler ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ── GET /api/room?code=XXXX ──
    if (req.method === 'GET') {
      const code = (req.query.code || '').toUpperCase().trim();
      if (!code) return res.status(400).json({ error: 'code required' });
      const room = await getRoom(code);
      if (!room) return res.status(404).json({ error: 'Room not found' });
      return res.status(200).json(room);
    }

    // ── POST /api/room ──
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
      }
      if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Body required' });

      const { action } = body;

      // CREATE
      if (action === 'create') {
        const { state } = body;
        if (!state || !state.roomCode) return res.status(400).json({ error: 'roomCode required' });
        const code = state.roomCode.toUpperCase();
        state.createdAt = new Date().toISOString();
        await setRoom(code, state);
        return res.status(200).json({ ok: true, code });
      }

      // UPDATE
      if (action === 'update') {
        const { code, patch } = body;
        if (!code) return res.status(400).json({ error: 'code required' });
        const room = await getRoom(code.toUpperCase());
        if (!room) return res.status(404).json({ error: 'Room not found' });

        if (patch && patch.results) {
          if (!room.results) room.results = {};
          Object.assign(room.results, patch.results);
        }
        if (patch && patch.round !== undefined) room.round = patch.round;
        room.v = (room.v || 1) + 1;
        room.updatedAt = new Date().toISOString();
        await setRoom(code.toUpperCase(), room);
        return res.status(200).json({ ok: true, v: room.v });
      }

      return res.status(400).json({ error: 'Unknown action: ' + action });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[room handler]', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
