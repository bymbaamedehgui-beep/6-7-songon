// api/room.js — Vercel Serverless Function
// GET  /api/room?code=XXXX                         → room state буцаана
// POST /api/room {action:'create', state:{...}}    → room үүсгэнэ
// POST /api/room {action:'update', code, patch:{}} → шинэчилнэ
//
// state.cm = {grade:'6'..'12', topic:<node_id|0>, ids:[cyber-math бодлогын id], tname?}
//   — багшийн сонгосон анги/сэдэв; бүх tablet ids-аар ижил бодлого татна (public/index.html).
// KV (KV_REST_API_URL/TOKEN) байхгүй/алдаатай үед өрөө түр санах ойд үлдэнэ —
// хариунд persisted:false, storage:'memory' гэж буцааж клиент ойлгомжтой анхааруулга харуулна.

const mem = {}; // in-memory fallback (same Vercel instance)

const GRADES = ['6', '7', '8', '9', '10', '11', '12'];
function kvConfigured() {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}
function storageName() { return kvConfigured() ? 'kv' : 'memory'; }

// Өрөөний төлөв дэх анги/сэдвийн мэдээллийг шалгаж цэвэрлэнэ (буруу бол хасна → жишиг сан)
function cleanCm(cm) {
  if (!cm || typeof cm !== 'object') return null;
  const grade = String(cm.grade == null ? '' : cm.grade);
  if (!GRADES.includes(grade)) return null;
  const topic = parseInt(cm.topic, 10);
  const ids = Array.isArray(cm.ids)
    ? cm.ids.map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x) && x > 0).slice(0, 80)
    : [];
  if (!ids.length) return null;
  const out = { grade, topic: Number.isFinite(topic) && topic > 0 ? topic : 0, ids };
  if (cm.tname) out.tname = String(cm.tname).slice(0, 120);
  return out;
}

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
    if (!r.ok) console.error('[kvSet] HTTP', r.status);
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

// true = KV-д хадгалагдсан (бүх instance харна), false = зөвхөн энэ instance-ийн санах ойд
async function setRoom(code, data) {
  const ok = await kvSet(code, data);
  if (!ok) console.warn('[setRoom] KV unavailable, using mem fallback (' + storageName() + ')');
  mem[code] = data;
  return ok;
}

function memWarning() {
  return kvConfigured()
    ? 'Өрөөний санд (KV) бичиж чадсангүй — өрөө түр санах ойд хадгалагдлаа.'
    : 'Өрөөний сан (KV_REST_API_URL / KV_REST_API_TOKEN) тохируулаагүй — өрөө түр санах ойд хадгалагдлаа.';
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
      res.setHeader('Cache-Control', 'no-store');
      const code = String((req.query && req.query.code) || '').toUpperCase().trim();
      if (!code) return res.status(400).json({ error: 'code required', message: 'Өрөөний код шаардлагатай' });
      const room = await getRoom(code);
      if (!room) {
        return res.status(404).json({ error: 'Room not found', message: 'Өрөө олдсонгүй', storage: storageName() });
      }
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
        const code = String(state.roomCode).toUpperCase();
        if ('cm' in state) {
          const cm = cleanCm(state.cm);
          if (cm) state.cm = cm; else delete state.cm;
        }
        state.createdAt = new Date().toISOString();
        const persisted = await setRoom(code, state);
        const out = { ok: true, code, persisted, storage: persisted ? 'kv' : 'memory' };
        if (!persisted) out.warning = memWarning();
        return res.status(200).json(out);
      }

      // UPDATE
      if (action === 'update') {
        const { code, patch } = body;
        if (!code) return res.status(400).json({ error: 'code required' });
        const room = await getRoom(String(code).toUpperCase());
        if (!room) {
          return res.status(404).json({ error: 'Room not found', message: 'Өрөө олдсонгүй', storage: storageName() });
        }

        if (patch && patch.results && typeof patch.results === 'object') {
          if (!room.results) room.results = {};
          for (const [k, val] of Object.entries(patch.results)) {
            // Тоглолтын хариултын («…_ans») объектыг нэгтгэнэ: хоёр tablet бараг зэрэг хариулахад
            // (өөр өөрийн хуучин хуулбараас илгээхэд) нэг нь нөгөөгийнхөө хариуг дарж устгахаас сэргийлнэ.
            const cur = room.results[k];
            if (/_ans$/.test(k) && val && typeof val === 'object' && cur && typeof cur === 'object') {
              room.results[k] = Object.assign({}, cur, val);
            } else {
              room.results[k] = val;
            }
          }
        }
        if (patch && patch.round !== undefined) room.round = patch.round;
        room.v = (room.v || 1) + 1;
        room.updatedAt = new Date().toISOString();
        const persisted = await setRoom(String(code).toUpperCase(), room);
        return res.status(200).json({ ok: true, v: room.v, persisted });
      }

      return res.status(400).json({ error: 'Unknown action: ' + action });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[room handler]', err);
    return res.status(500).json({
      error: err.message || 'Internal server error',
      message: 'Өрөөний серверийн алдаа. Түр хүлээгээд дахин оролдоно уу.'
    });
  }
}
