// api/lib/store.js — armazenamento chave/valor mínimo para pedidos, presença e métricas.
//
// Usa Redis via REST (Upstash / Vercel KV) quando as variáveis de ambiente existem:
//   KV_REST_API_URL + KV_REST_API_TOKEN   (Vercel KV / Upstash pela integração da Vercel)
//   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
// Sem elas, guarda tudo em memória e (fora da Vercel) persiste em data/db.json.
const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');

const REDIS_URL   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL   || '';
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const USE_REDIS   = Boolean(REDIS_URL && REDIS_TOKEN);
const ON_VERCEL   = Boolean(process.env.VERCEL);
// Prefixo de todas as chaves: permite dividir o mesmo Redis com outro projeto
// (ex.: o do rastreio) sem misturar dados. Mude com a variável REDIS_PREFIX.
const PREFIX      = process.env.REDIS_PREFIX ?? 'bazari:';
const P           = key => PREFIX + key;

// ─── Backend Redis (REST) ─────────────────────────────────────────────────────
async function redis(cmd) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd.map(String)),
  });
  const json = await res.json();
  if (json.error) throw new Error(`Redis: ${json.error}`);
  return json.result;
}

async function redisPipeline(cmds) {
  if (!cmds.length) return [];
  const res = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds.map(c => c.map(String))),
  });
  const json = await res.json();
  return json.map(r => (r.error ? null : r.result));
}

// ─── Backend memória/arquivo ──────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'db.json');
const mem = global.__bazariStore || (global.__bazariStore = { kv: {}, exp: {}, z: {}, h: {}, s: {} });

if (!USE_REDIS && !ON_VERCEL && !mem.loaded) {
  mem.loaded = true;
  try {
    Object.assign(mem, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
    for (const k of Object.keys(mem.s)) mem.s[k] = new Set(mem.s[k]);
  } catch { /* primeiro uso */ }
}

let saveTimer = null;
function persist() {
  if (USE_REDIS || ON_VERCEL) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      const s = {};
      for (const k of Object.keys(mem.s)) s[k] = [...mem.s[k]];
      // presença é efêmera: não vale a pena gravar em disco
      const { presence, ...h } = mem.h;
      fs.writeFileSync(DATA_FILE, JSON.stringify({ kv: mem.kv, exp: mem.exp, z: mem.z, h, s }));
    } catch (e) { console.error('[store] Falha ao gravar data/db.json:', e.message); }
  }, 300);
}

function alive(key) {
  const e = mem.exp[key];
  if (e && e < Date.now()) { delete mem.kv[key]; delete mem.exp[key]; return false; }
  return key in mem.kv;
}

// ─── API pública ──────────────────────────────────────────────────────────────
const store = {
  mode: USE_REDIS ? 'redis' : (ON_VERCEL ? 'memory' : 'file'),

  async getJSON(key) {
    if (USE_REDIS) { const v = await redis(['GET', P(key)]); return v ? JSON.parse(v) : null; }
    return alive(key) ? JSON.parse(mem.kv[key]) : null;
  },

  async mgetJSON(keys) {
    if (!keys.length) return [];
    if (USE_REDIS) return (await redis(['MGET', ...keys.map(P)])).map(v => (v ? JSON.parse(v) : null));
    return keys.map(k => (alive(k) ? JSON.parse(mem.kv[k]) : null));
  },

  async setJSON(key, value, ttlSec) {
    const v = JSON.stringify(value);
    if (USE_REDIS) return redis(ttlSec ? ['SET', P(key), v, 'EX', ttlSec] : ['SET', P(key), v]);
    mem.kv[key] = v;
    if (ttlSec) mem.exp[key] = Date.now() + ttlSec * 1000; else delete mem.exp[key];
    persist();
  },

  async del(key) {
    if (USE_REDIS) return redis(['DEL', P(key)]);
    delete mem.kv[key]; delete mem.exp[key]; persist();
  },

  // Acesso a uma chave CRUA, sem o prefixo bazari: — usado para a chave
  // "rastreios_db", compartilhada com o site de rastreio (mesmo Redis).
  async getRawJSON(key) {
    if (USE_REDIS) { const v = await redis(['GET', key]); return v ? JSON.parse(v) : null; }
    return store.getJSON(key);
  },
  async setRawJSON(key, value) {
    if (USE_REDIS) return redis(['SET', key, JSON.stringify(value)]);
    return store.setJSON(key, value);
  },

  // Sorted set (índice de pedidos por data)
  async zadd(key, score, member) {
    if (USE_REDIS) return redis(['ZADD', P(key), score, member]);
    (mem.z[key] ||= {})[member] = score; persist();
  },

  async zrevrange(key, start, stop) {
    if (USE_REDIS) return redis(['ZRANGE', P(key), start, stop, 'REV']);
    const arr = Object.entries(mem.z[key] || {}).sort((a, b) => b[1] - a[1]).map(e => e[0]);
    return arr.slice(start, stop === -1 ? undefined : stop + 1);
  },

  // Hash (presença ao vivo e contadores diários)
  async hset(key, field, value) {
    if (USE_REDIS) return redis(['HSET', P(key), field, value]);
    (mem.h[key] ||= {})[field] = String(value);
    if (key !== 'presence') persist();
  },

  async hgetall(key) {
    if (USE_REDIS) {
      const flat = await redis(['HGETALL', P(key)]) || [];
      const out = {};
      for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
      return out;
    }
    return { ...(mem.h[key] || {}) };
  },

  async hget(key, field) {
    if (USE_REDIS) return redis(['HGET', P(key), field]);
    return (mem.h[key] || {})[field] ?? null;
  },

  // Vários comandos de escrita numa ida só ao Redis (heartbeat do "ao vivo")
  async batch(ops) {
    if (USE_REDIS) {
      return redisPipeline(ops.map(([cmd, key, ...args]) => [cmd, P(key), ...args]));
    }
    for (const [cmd, key, ...args] of ops) {
      if (cmd === 'HSET') await store.hset(key, args[0], args[1]);
      else if (cmd === 'HINCRBY') await store.hincrby(key, args[0], args[1]);
      else if (cmd === 'SADD') await store.sadd(key, args[0]);
      else if (cmd === 'EXPIRE') { /* sem TTL no modo arquivo */ }
    }
  },

  async hdel(key, ...fields) {
    if (!fields.length) return;
    if (USE_REDIS) return redis(['HDEL', P(key), ...fields]);
    for (const f of fields) delete (mem.h[key] || {})[f];
  },

  async hincrby(key, field, by = 1) {
    if (USE_REDIS) return redis(['HINCRBY', P(key), field, by]);
    const h = (mem.h[key] ||= {});
    h[field] = String((parseInt(h[field], 10) || 0) + by);
    persist();
  },

  // Set (visitantes únicos por dia)
  async sadd(key, member) {
    if (USE_REDIS) return redis(['SADD', P(key), member]);
    (mem.s[key] ||= new Set()).add(member); persist();
  },

  async scard(key) {
    if (USE_REDIS) return redis(['SCARD', P(key)]);
    return mem.s[key] ? mem.s[key].size : 0;
  },

  // Leitura em lote para os gráficos: contadores do dia + visitantes únicos
  // (total e por seção) — uma ida ao Redis em vez de dezenas.
  async dailyStats(dates, sections) {
    const setKeys = d => [`uv:${d}`, ...sections.map(s => `uv:${d}:${s}`)];
    if (USE_REDIS) {
      const cmds = [];
      for (const d of dates) {
        cmds.push(['HGETALL', P(`stats:${d}`)]);
        for (const k of setKeys(d)) cmds.push(['SCARD', P(k)]);
      }
      const r = await redisPipeline(cmds);
      const per = 1 + setKeys('x').length;
      return dates.map((d, i) => {
        const flat = r[i * per] || [];
        const h = {};
        for (let j = 0; j < flat.length; j += 2) h[flat[j]] = flat[j + 1];
        const counts = r.slice(i * per + 1, (i + 1) * per).map(n => n || 0);
        const bySection = {};
        sections.forEach((s, j) => { bySection[s] = counts[j + 1]; });
        return { date: d, h, unique: counts[0], uniqueBySection: bySection };
      });
    }
    const size = k => (mem.s[k] ? mem.s[k].size : 0);
    return dates.map(d => {
      const bySection = {};
      for (const s of sections) bySection[s] = size(`uv:${d}:${s}`);
      return { date: d, h: { ...(mem.h[`stats:${d}`] || {}) }, unique: size(`uv:${d}`), uniqueBySection: bySection };
    });
  },
};

module.exports = store;
