// api/lib/panel.js — pedidos, rastreamento de visitantes e API do painel /admin.
const crypto = require('crypto');
const store  = require('./store');

// ─── Config do painel ─────────────────────────────────────────────────────────
// Em produção (Vercel) a senha vem SÓ da variável ADMIN_PASS — o repositório é
// público, então uma senha escrita aqui daria acesso aos dados dos clientes.
// A senha padrão abaixo só vale rodando no seu computador.
const ADMIN_USER   = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS   = process.env.ADMIN_PASS || (process.env.VERCEL ? '' : 'pizza2024');
const ADMIN_SECRET = process.env.ADMIN_SECRET
  || crypto.createHash('sha256').update(`bazari-admin|${ADMIN_USER}|${ADMIN_PASS}`).digest('hex');
const SESSION_DAYS = 7;
const COOKIE       = 'bz_admin';

const SECTIONS       = ['lp', 'checkout', 'pix', 'obrigado', 'rastreio'];
// Etapas do checkout contadas no funil (a etapa 1 é a própria visita ao checkout)
const STEP_SECTIONS  = ['checkout_s2', 'checkout_s3'];
const ONLINE_WINDOW  = 45 * 1000;      // sem heartbeat há 45s → saiu (heartbeat a cada 15s)
const PRESENCE_PURGE = 2 * 60 * 1000;  // limpa entradas paradas
const MAX_RECEIPT_B64 = store.mode === 'redis' ? 1_300_000 : 6_000_000; // ≈ 1 MB / 4.5 MB
const RECEIPT_TYPES  = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
const FULFILLMENT    = ['novo', 'separando', 'enviado', 'entregue', 'cancelado'];

// Endereço público da loja: usado no callback_url do PIX e nos eventos da Meta.
const SITE_URL    = (process.env.SITE_URL || 'https://bazari-store.vercel.app').replace(/\/+$/, '');
const WEBHOOK_URL = `${SITE_URL}/api/webhook/veno`;

const tz = 'America/Sao_Paulo';
const dayKey = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);

// ─── Pedidos ──────────────────────────────────────────────────────────────────
const orderKey = id => `order:${id}`;

async function getOrder(id) { return store.getJSON(orderKey(id)); }

// pixId → nº do pedido nunca muda: guarda em memória e economiza 1 leitura do
// Redis a cada consulta de status feita pela tela do PIX.
const pixToOrder = new Map();
async function getOrderByPix(pixId) {
  let id = pixToOrder.get(pixId);
  if (!id) {
    id = await store.getJSON(`pix:${pixId}`);
    if (id) {
      pixToOrder.set(pixId, id);
      if (pixToOrder.size > 5000) pixToOrder.delete(pixToOrder.keys().next().value);
    }
  }
  return id ? getOrder(id) : null;
}

function pushEvent(order, type, detail) {
  order.events = order.events || [];
  order.events.push({ type, at: new Date().toISOString(), ...(detail ? { detail } : {}) });
}

async function saveOrder(order) {
  order.updatedAt = new Date().toISOString();
  await store.setJSON(orderKey(order.id), order);
}

async function createOrder(data) {
  const now = new Date();
  const order = {
    id: String(data.orderId),
    pixId: data.pixId || null,
    txid: data.txid || null,
    createdAt: now.toISOString(),
    status: 'pending',
    paidAt: null,
    paidVia: null,
    expiresAt: data.expiresAt || null,
    total: data.total,
    customer: { nome: data.nome, email: data.email, cpf: data.cpf, telefone: data.telefone },
    address: data.address || {},
    items: data.items || [],
    variant: data.variant || '',
    quantity: data.quantity || 1,
    shipping: data.shipping || '',
    orderBump: Boolean(data.orderBump),
    utm: data.utm || {},
    vid: data.vid || null,
    meta: { fbc: data.fbc || '', fbp: data.fbp || '' }, // para o Purchase da Meta
    pixCopied: false, pixCopiedAt: null, copyCount: 0,
    receipt: null,
    fulfillment: 'novo',
    tracking: '',
    notes: '',
    events: [],
  };
  pushEvent(order, 'created', `PIX gerado — R$ ${Number(order.total).toFixed(2).replace('.', ',')}`);
  await saveOrder(order);
  await store.zadd('orders', now.getTime(), order.id);
  if (order.pixId) await store.setJSON(`pix:${order.pixId}`, order.id);
  await store.hincrby(`stats:${dayKey(now)}`, 'orders', 1);
  return order;
}

// Marca como pago (idempotente). Retorna true se mudou agora.
async function markPaid(pixId, via, extra = {}) {
  const order = await getOrderByPix(pixId);
  if (!order || order.status === 'paid') return false;
  order.status = 'paid';
  order.paidAt = extra.paidAt || new Date().toISOString();
  order.paidVia = via;
  pushEvent(order, 'paid', `Pagamento confirmado (${via})`);
  await saveOrder(order);
  await store.hincrby(`stats:${dayKey()}`, 'paid', 1);
  return true;
}

// Status da Veno → status do painel. (doc: pending, paid, expired, cancelled,
// refunded, authorized, captured, denied, chargeback, disputed)
const VENO_STATUS = {
  pending: 'pending', authorized: 'pending',
  paid: 'paid', captured: 'paid',
  expired: 'expired', cancelled: 'canceled', canceled: 'canceled', denied: 'failed',
  refunded: 'refunded', chargeback: 'chargeback', disputed: 'disputed',
};
const normalizeStatus = s => VENO_STATUS[String(s || '').toLowerCase()] || null;
const LABEL = { paid: 'pago', expired: 'expirado', canceled: 'cancelado', failed: 'recusado',
  refunded: 'estornado', chargeback: 'chargeback (contestação)', disputed: 'em disputa' };

// Aplica um status vindo da Veno. Retorna true se o pedido mudou.
async function setGatewayStatus(pixId, rawStatus, via, data = {}) {
  const status = normalizeStatus(rawStatus);
  if (!status || status === 'pending') return false;
  if (status === 'paid') {
    const changed = await markPaid(pixId, via, { paidAt: data.paid_at });
    if (data.end_to_end_id) {
      const o = await getOrderByPix(pixId);
      if (o && !o.endToEndId) { o.endToEndId = data.end_to_end_id; await saveOrder(o); }
    }
    return changed;
  }
  const order = await getOrderByPix(pixId);
  if (!order || order.status === status) return false;
  // Depois de pago, só estorno / chargeback / disputa mudam o pedido
  if (order.status === 'paid' && !['refunded', 'chargeback', 'disputed'].includes(status)) return false;
  order.status = status;
  pushEvent(order, 'status', `Gateway: ${LABEL[status] || status} (${via})`);
  await saveOrder(order);
  return true;
}

// Pedido pendente com PIX vencido aparece como "expirado" sem precisar de job.
function effectiveStatus(o) {
  if (o.status === 'pending' && o.expiresAt && new Date(o.expiresAt).getTime() < Date.now()) return 'expired';
  return o.status;
}

async function allOrders() {
  const ids = await store.zrevrange('orders', 0, -1);
  const out = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = await store.mgetJSON(ids.slice(i, i + 200).map(orderKey));
    out.push(...chunk.filter(Boolean));
  }
  return out.map(o => ({ ...o, status: effectiveStatus(o) }));
}

function summary(o) {
  return {
    id: o.id, createdAt: o.createdAt, status: o.status, paidAt: o.paidAt, total: o.total,
    nome: o.customer?.nome, email: o.customer?.email, telefone: o.customer?.telefone,
    cidade: o.address?.city, uf: o.address?.state,
    pixCopied: o.pixCopied, copyCount: o.copyCount, hasReceipt: Boolean(o.receipt),
    fulfillment: o.fulfillment, tracking: o.tracking, utm_source: o.utm?.utm_source || '',
    orderBump: o.orderBump, variant: o.variant,
  };
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
const b64u = s => Buffer.from(s).toString('base64url');
const sign = s => crypto.createHmac('sha256', ADMIN_SECRET).update(s).digest('base64url');

function makeToken() {
  const body = b64u(JSON.stringify({ u: ADMIN_USER, exp: Date.now() + SESSION_DAYS * 864e5 }));
  return `${body}.${sign(body)}`;
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}

function verifyToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return false;
  const expected = sign(body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()).exp > Date.now(); } catch { return false; }
}

function requireAdmin(req, res, next) {
  if (verifyToken(readCookie(req, COOKIE))) return next();
  res.status(401).json({ error: 'Não autenticado' });
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const loginAttempts = new Map(); // ip → { n, until }
function clientIp(req) { return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || ''; }

// ─── Rotas ────────────────────────────────────────────────────────────────────
function register(app) {
  const both = p => [`/api${p}`, p];

  // ── Rastreamento (público, chamado pelo track.js das páginas) ──
  app.post(both('/track/heartbeat'), async (req, res) => {
    try {
      const { vid, page, path, view, stepView, ref, utm_source, device, orderId } = req.body || {};
      const step = page === 'checkout' ? Math.min(3, Math.max(1, parseInt(req.body.step, 10) || 1)) : 0;
      if (!vid || typeof vid !== 'string' || vid.length > 64 || !SECTIONS.includes(page)) {
        return res.status(400).json({ error: 'payload inválido' });
      }
      const now = Date.now();
      const prevRaw = await store.hget('presence', vid);
      const prev = prevRaw ? JSON.parse(prevRaw) : null;
      const entry = {
        vid, page,
        path: String(path || '').slice(0, 200),
        since: prev && prev.page === page ? prev.since : now,
        firstSeen: prev ? prev.firstSeen : now,
        lastSeen: now,
        ref: String(ref || prev?.ref || '').slice(0, 200),
        utm_source: String(utm_source || prev?.utm_source || '').slice(0, 80),
        device: device === 'mobile' ? 'mobile' : 'desktop',
        orderId: orderId ? String(orderId).slice(0, 20) : (prev?.orderId || null),
        step,
      };
      // Tudo numa ida só ao Redis. Heartbeat comum = 2 comandos (HGET + HSET).
      const ops = [['HSET', 'presence', vid, JSON.stringify(entry)]];
      if (view) {
        const d = dayKey();
        const keep = 120 * 86400; // contadores de visitantes somem após 120 dias
        ops.push(
          ['HINCRBY', `stats:${d}`, `view:${page}`, 1],
          ['SADD', `uv:${d}`, vid], ['EXPIRE', `uv:${d}`, keep],
          ['SADD', `uv:${d}:${page}`, vid], ['EXPIRE', `uv:${d}:${page}`, keep],
        );
      }
      if (stepView && step >= 2) {
        const d = dayKey();
        ops.push(['SADD', `uv:${d}:checkout_s${step}`, vid], ['EXPIRE', `uv:${d}:checkout_s${step}`, 120 * 86400]);
      }
      await store.batch(ops);
      res.json({ ok: true });
    } catch (e) {
      console.error('[track] heartbeat:', e.message);
      res.status(500).json({ error: 'erro' });
    }
  });

  app.post(both('/track/leave'), async (req, res) => {
    try {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      // Só remove se ele ainda está na página que fechou — ao navegar LP → checkout,
      // o "leave" da LP pode chegar depois do heartbeat do checkout.
      if (body?.vid) {
        const raw = await store.hget('presence', String(body.vid));
        const cur = raw ? JSON.parse(raw) : null;
        if (cur && (!body.page || cur.page === body.page)) await store.hdel('presence', String(body.vid));
      }
    } catch { /* ignore */ }
    res.status(204).end();
  });

  // ── Eventos do cliente na tela do PIX ──
  async function orderForClient(req, res) {
    const { pixId } = req.body || {};
    const order = await getOrder(req.params.id);
    if (!order || !pixId || order.pixId !== pixId) {
      res.status(404).json({ error: 'Pedido não encontrado' });
      return null;
    }
    return order;
  }

  app.post(both('/orders/:id/copied'), async (req, res) => {
    try {
      const order = await orderForClient(req, res);
      if (!order) return;
      order.copyCount = (order.copyCount || 0) + 1;
      if (!order.pixCopied) {
        order.pixCopied = true;
        order.pixCopiedAt = new Date().toISOString();
        pushEvent(order, 'copied', 'Cliente copiou o código PIX');
        await store.hincrby(`stats:${dayKey()}`, 'copied', 1);
      }
      await saveOrder(order);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post(both('/orders/:id/receipt'), async (req, res) => {
    try {
      const order = await orderForClient(req, res);
      if (!order) return;
      const { name, type, data } = req.body || {};
      if (!RECEIPT_TYPES.includes(type)) return res.status(400).json({ error: 'Formato não aceito. Envie JPG, PNG, WEBP ou PDF.' });
      if (typeof data !== 'string' || !data.length) return res.status(400).json({ error: 'Arquivo vazio.' });
      if (data.length > MAX_RECEIPT_B64) return res.status(413).json({ error: 'Arquivo muito grande. Envie um print ou PDF menor.' });
      const size = Math.floor(data.length * 3 / 4);
      const uploadedAt = new Date().toISOString();
      await store.setJSON(`receipt:${order.id}`, { name: String(name || 'comprovante').slice(0, 120), type, data, uploadedAt });
      const first = !order.receipt;
      order.receipt = { name: String(name || 'comprovante').slice(0, 120), type, size, uploadedAt };
      pushEvent(order, 'receipt', first ? 'Cliente anexou comprovante' : 'Cliente reenviou comprovante');
      if (first) await store.hincrby(`stats:${dayKey()}`, 'receipts', 1);
      await saveOrder(order);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Login ──
  app.post(both('/admin/login'), (req, res) => {
    const ip = clientIp(req);
    const a = loginAttempts.get(ip);
    if (a && a.until > Date.now()) return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' });
    const { user, pass } = req.body || {};
    if (!ADMIN_PASS) {
      return res.status(503).json({ error: 'Painel sem senha configurada. Cadastre ADMIN_PASS nas variáveis de ambiente da Vercel.' });
    }
    if (safeEqual(user, ADMIN_USER) && safeEqual(pass, ADMIN_PASS)) {
      loginAttempts.delete(ip);
      const secure = (req.headers['x-forwarded-proto'] || req.protocol) === 'https' ? '; Secure' : '';
      res.setHeader('Set-Cookie', `${COOKIE}=${makeToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
      return res.json({ ok: true });
    }
    const n = (a?.n || 0) + 1;
    loginAttempts.set(ip, { n: n >= 8 ? 0 : n, until: n >= 8 ? Date.now() + 10 * 60e3 : 0 });
    res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  });

  app.post(both('/admin/logout'), (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });

  app.get(both('/admin/me'), requireAdmin, (req, res) => {
    res.json({ user: ADMIN_USER, storage: store.mode, webhookUrl: WEBHOOK_URL });
  });

  // ── Pedidos ──
  app.get(both('/admin/orders'), requireAdmin, async (req, res) => {
    try {
      const { status = '', q = '', copied = '', receipt = '', fulfillment = '', from = '', to = '' } = req.query;
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const per  = Math.min(100, Math.max(5, parseInt(req.query.per, 10) || 20));
      let list = await allOrders();
      if (status)      list = list.filter(o => o.status === status);
      if (fulfillment) list = list.filter(o => o.fulfillment === fulfillment);
      if (copied)      list = list.filter(o => String(Boolean(o.pixCopied)) === copied);
      if (receipt)     list = list.filter(o => String(Boolean(o.receipt)) === receipt);
      if (from)        list = list.filter(o => dayKey(new Date(o.createdAt)) >= from);
      if (to)          list = list.filter(o => dayKey(new Date(o.createdAt)) <= to);
      if (q) {
        const needle = String(q).toLowerCase();
        const digits = needle.replace(/\D/g, '');
        list = list.filter(o => [o.id, o.customer?.nome, o.customer?.email, o.tracking, o.address?.city]
          .some(v => String(v || '').toLowerCase().includes(needle))
          || (digits.length >= 3 && [o.customer?.cpf, o.customer?.telefone].some(v => String(v || '').replace(/\D/g, '').includes(digits))));
      }
      const total = list.length;
      res.json({ total, page, per, orders: list.slice((page - 1) * per, page * per).map(summary) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get(both('/admin/orders.csv'), requireAdmin, async (req, res) => {
    const list = await allOrders();
    const cols = ['Pedido', 'Data', 'Status', 'Pago em', 'Total', 'Nome', 'Email', 'Telefone', 'CPF', 'CEP', 'Endereço', 'Cidade', 'UF',
      'Voltagem', 'Qtd', 'Frete', 'Garantia', 'Copiou PIX', 'Comprovante', 'Envio', 'Rastreio', 'utm_source', 'utm_campaign', 'Observações'];
    const esc = v => { const s = String(v ?? ''); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const fmt = iso => iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: tz }) : '';
    const rows = list.map(o => [o.id, fmt(o.createdAt), o.status, fmt(o.paidAt), String(Number(o.total).toFixed(2)).replace('.', ','),
      o.customer?.nome, o.customer?.email, o.customer?.telefone, o.customer?.cpf, o.address?.cep,
      [o.address?.street, o.address?.number, o.address?.neighborhood].filter(Boolean).join(', '), o.address?.city, o.address?.state,
      o.variant, o.quantity, o.shipping, o.orderBump ? 'sim' : 'não', o.pixCopied ? 'sim' : 'não', o.receipt ? 'sim' : 'não',
      o.fulfillment, o.tracking, o.utm?.utm_source, o.utm?.utm_campaign, o.notes].map(esc).join(';'));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pedidos-${dayKey()}.csv"`);
    res.send('﻿' + [cols.join(';'), ...rows].join('\r\n'));
  });

  app.get(both('/admin/orders/:id'), requireAdmin, async (req, res) => {
    const o = await getOrder(req.params.id);
    if (!o) return res.status(404).json({ error: 'Pedido não encontrado' });
    res.json({ ...o, status: effectiveStatus(o) });
  });

  app.patch(both('/admin/orders/:id'), requireAdmin, async (req, res) => {
    try {
      const o = await getOrder(req.params.id);
      if (!o) return res.status(404).json({ error: 'Pedido não encontrado' });
      const { fulfillment, tracking, notes, status } = req.body || {};
      if (fulfillment !== undefined) {
        if (!FULFILLMENT.includes(fulfillment)) return res.status(400).json({ error: 'Status de envio inválido' });
        if (fulfillment !== o.fulfillment) pushEvent(o, 'fulfillment', `Envio: ${o.fulfillment} → ${fulfillment}`);
        o.fulfillment = fulfillment;
      }
      if (tracking !== undefined && tracking !== o.tracking) {
        o.tracking = String(tracking).slice(0, 60);
        pushEvent(o, 'tracking', o.tracking ? `Código de rastreio: ${o.tracking}` : 'Código de rastreio removido');
      }
      if (notes !== undefined) o.notes = String(notes).slice(0, 2000);
      if (status !== undefined) {
        if (status === 'paid' && o.status !== 'paid') {
          o.status = 'paid'; o.paidAt = new Date().toISOString(); o.paidVia = 'manual';
          pushEvent(o, 'paid', 'Marcado como pago manualmente');
          await store.hincrby(`stats:${dayKey()}`, 'paid', 1);
        } else if (status === 'pending' && o.status === 'paid') {
          o.status = 'pending'; o.paidAt = null; o.paidVia = null;
          pushEvent(o, 'status', 'Pagamento desmarcado manualmente');
          await store.hincrby(`stats:${dayKey()}`, 'paid', -1);
        } else if (status === 'canceled') {
          o.status = 'canceled';
          pushEvent(o, 'status', 'Pedido cancelado manualmente');
        }
      }
      await saveOrder(o);
      res.json({ ...o, status: effectiveStatus(o) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get(both('/admin/orders/:id/receipt'), requireAdmin, async (req, res) => {
    const r = await store.getJSON(`receipt:${req.params.id}`);
    if (!r) return res.status(404).send('Sem comprovante');
    res.setHeader('Content-Type', r.type);
    res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${r.name.replace(/[^\w.\- ]/g, '_')}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(Buffer.from(r.data, 'base64'));
  });

  // ── Visitantes ao vivo ──
  app.get(both('/admin/live'), requireAdmin, async (req, res) => {
    try {
      const all = await store.hgetall('presence');
      const now = Date.now();
      const online = [], stale = [];
      for (const [vid, raw] of Object.entries(all)) {
        let e; try { e = JSON.parse(raw); } catch { stale.push(vid); continue; }
        if (now - e.lastSeen > PRESENCE_PURGE) stale.push(vid);
        else if (now - e.lastSeen <= ONLINE_WINDOW) online.push(e);
      }
      if (stale.length) store.hdel('presence', ...stale).catch(() => {});
      const bySection = Object.fromEntries(SECTIONS.map(s => [s, 0]));
      online.forEach(e => { bySection[e.page] = (bySection[e.page] || 0) + 1; });
      online.sort((a, b) => b.lastSeen - a.lastSeen);
      res.json({ now, total: online.length, bySection, visitors: online });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Métricas do dashboard ──
  app.get(both('/admin/stats'), requireAdmin, async (req, res) => {
    try {
      const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
      const dates = [];
      for (let i = days - 1; i >= 0; i--) dates.push(dayKey(new Date(Date.now() - i * 864e5)));
      const fromKey = dates[0];

      const orders = (await allOrders()).filter(o => dayKey(new Date(o.createdAt)) >= fromKey);
      const paid = orders.filter(o => o.status === 'paid');
      const sum = arr => arr.reduce((s, o) => s + Number(o.total || 0), 0);

      const traffic = await store.dailyStats(dates, [...SECTIONS, ...STEP_SECTIONS]);
      const series = dates.map((d, i) => {
        const dayOrders = orders.filter(o => dayKey(new Date(o.createdAt)) === d);
        const dayPaid = dayOrders.filter(o => o.status === 'paid');
        return {
          date: d,
          orders: dayOrders.length,
          paid: dayPaid.length,
          revenue: sum(dayPaid),
          pending: sum(dayOrders.filter(o => o.status === 'pending')),
          visitors: traffic[i].unique,
          views: Object.fromEntries(SECTIONS.map(s => [s, parseInt(traffic[i].h[`view:${s}`], 10) || 0])),
        };
      });

      const uniq = s => traffic.reduce((n, t) => n + (t.uniqueBySection[s] || 0), 0);
      const visitors = traffic.reduce((n, t) => n + t.unique, 0);
      const bySource = {};
      orders.forEach(o => {
        const k = o.utm?.utm_source || 'direto';
        bySource[k] ||= { orders: 0, paid: 0, revenue: 0 };
        bySource[k].orders++;
        if (o.status === 'paid') { bySource[k].paid++; bySource[k].revenue += Number(o.total || 0); }
      });
      const byStatus = {};
      orders.forEach(o => { byStatus[o.status] = (byStatus[o.status] || 0) + 1; });
      const byHour = Array(24).fill(0);
      paid.forEach(o => {
        const h = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date(o.paidAt || o.createdAt)), 10);
        byHour[h]++;
      });

      res.json({
        days,
        kpis: {
          revenue: sum(paid),
          pendingRevenue: sum(orders.filter(o => o.status === 'pending')),
          orders: orders.length,
          paid: paid.length,
          avgTicket: paid.length ? sum(paid) / paid.length : 0,
          paymentRate: orders.length ? paid.length / orders.length : 0,
          copied: orders.filter(o => o.pixCopied).length,
          receipts: orders.filter(o => o.receipt).length,
          receiptsUnpaid: orders.filter(o => o.receipt && o.status !== 'paid').length,
          bumpRate: orders.length ? orders.filter(o => o.orderBump).length / orders.length : 0,
          visitors,
          conversion: visitors ? paid.length / visitors : 0,
          toShip: orders.filter(o => o.status === 'paid' && ['novo', 'separando'].includes(o.fulfillment)).length,
        },
        funnel: {
          lp: uniq('lp'), checkout: uniq('checkout'),
          checkoutEntrega: uniq('checkout_s2'), checkoutPagamento: uniq('checkout_s3'), pix: orders.length,
          copied: orders.filter(o => o.pixCopied).length, paid: paid.length,
        },
        series, bySource, byStatus, byHour,
        recent: orders.slice(0, 8).map(summary),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { SITE_URL, WEBHOOK_URL, register, createOrder, markPaid, setGatewayStatus, normalizeStatus, getOrderByPix, getOrder, requireAdmin, storeMode: store.mode };
