// api/index.js — Vercel Serverless Function para Veno Payments PIX + Meta CAPI
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const https   = require('https');
const crypto  = require('crypto');
const panel   = require('./lib/panel');
const rastreio = require('./lib/rastreio');

const app = express();
app.use(cors());
app.use(express.json({ limit: '6mb' }));      // comprovantes chegam em base64
app.use(express.text({ limit: '10kb' }));     // navigator.sendBeacon (saída do site)

// ─── Config ───────────────────────────────────────────────────────────────────
// Chaves vêm de variáveis de ambiente (.env local / Vercel). Nada de segredo no código.
const VENO_API_KEY  = process.env.VENO_API_KEY || '';
const VENO_BASE_URL = process.env.VENO_BASE_URL || 'https://beta.venopayments.com';
const httpsAgent    = new https.Agent({ rejectUnauthorized: false });

// IDs dos pixels são públicos (ficam no navegador); só os tokens do CAPI são segredo.
const META_PIXELS = [
  { id: '1448868326836788',  token: process.env.META_CAPI_TOKEN_1 || '' },
  { id: '29370137919281276', token: process.env.META_CAPI_TOKEN_2 || '' },
  { id: '1715304620163972',  token: process.env.META_CAPI_TOKEN_3 || '' },
].filter(p => p.token); // sem token configurado → não envia para aquele pixel

// Cache de status pagos (em memória)
const paidPixStore = new Set();

// ─── Helpers CAPI ─────────────────────────────────────────────────────────────
function hashSHA256(value) {
  if (value === undefined || value === null) return undefined;
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

async function sendMetaEvent({ eventName, eventId, userData = {}, customData = {}, sourceUrl = '' }) {
  try {
    const payload = {
      data: [{
        event_name:  eventName,
        event_time:  Math.floor(Date.now() / 1000),
        event_id:    eventId,
        event_source_url: sourceUrl || `${panel.SITE_URL}/`,
        action_source: 'website',
        user_data: {
          em:  userData.email    ? [hashSHA256(userData.email)]    : undefined,
          ph:  userData.telefone ? [hashSHA256(userData.telefone.replace(/\D/g, ''))] : undefined,
          fn:  userData.nome     ? [hashSHA256(userData.nome.split(' ')[0])] : undefined,
          ln:  userData.nome && userData.nome.includes(' ')
                 ? [hashSHA256(userData.nome.split(' ').slice(1).join(' '))]
                 : undefined,
          zp:  userData.cep     ? [hashSHA256(userData.cep.replace(/\D/g, ''))]  : undefined,
          external_id: userData.orderId ? [hashSHA256(userData.orderId)] : undefined,
          client_ip_address: userData.ip   || undefined,
          client_user_agent: userData.ua   || undefined,
          fbc:  userData.fbc  || undefined,
          fbp:  userData.fbp  || undefined,
        },
        custom_data: customData,
      }],
    };

    // Remove undefined recursivamente
    const clean = JSON.parse(JSON.stringify(payload));

    await Promise.allSettled(
      META_PIXELS.map(async (pixel) => {
        try {
          const res = await fetch(`https://graph.facebook.com/v19.0/${pixel.id}/events?access_token=${pixel.token}`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(clean),
          });
          const result = await res.json();
          console.log(`[Meta CAPI - Pixel ${pixel.id}] ${eventName} → events_received:`, result.events_received, result.messages || '');
        } catch (subErr) {
          console.error(`[Meta CAPI - Pixel ${pixel.id}] Erro:`, subErr.message);
        }
      })
    );
  } catch (err) {
    console.error('[Meta CAPI] Erro ao enviar evento:', err.message);
  }
}

// ─── Healthcheck / Ping ───────────────────────────────────────────────────────
app.get(['/', '/api'], (req, res) => {
  res.json({ status: 'ok', message: 'Bazari Veno API online na Vercel', time: new Date().toISOString() });
});

// ─── Painel admin, pedidos e rastreamento de visitantes ───────────────────────
panel.register(app);
rastreio.register(app, panel.requireAdmin);

// ─── POST /api/pix/criar ──────────────────────────────────────────────────────
app.post(['/api/pix/criar', '/pix/criar'], async (req, res) => {
  try {
    const { nome, email, cpf, telefone, cep, total, orderBump, orderId, fbc, fbp,
            utm_source, utm_campaign, utm_medium, utm_content, utm_term, src, sck,
            address, variant, quantity, shipping, vid, ic_event_id } = req.body || {};

    if (!nome || !email || !cpf || !telefone || !total) {
      return res.status(400).json({ error: 'Campos obrigatórios faltando.' });
    }

    const cleanTotal   = typeof total === 'string' ? parseFloat(total.replace(',', '.')) : Number(total);
    const amountCents  = Math.round(cleanTotal * 100);
    const clientIp     = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '';
    const clientUa     = req.headers['user-agent'] || '';
    // Usa o mesmo event_id gerado ao entrar no checkout (dedupe com o Pixel do navegador)
    const eventId      = ic_event_id || `initiate-${orderId || Date.now()}`;

    // ── Dispara InitiateCheckout no CAPI ──
    sendMetaEvent({
      eventName:  'InitiateCheckout',
      eventId,
      userData:   { email, telefone, nome, cep, orderId, ip: clientIp, ua: clientUa, fbc, fbp },
      customData: {
        value:        cleanTotal,
        currency:     'BRL',
        num_items:    orderBump ? 2 : 1,
        content_ids:  ['lavadora-tramontina-1200w', ...(orderBump ? ['garantia-vip-12m'] : [])],
        content_type: 'product',
      },
      sourceUrl: `${panel.SITE_URL}/checkout.html`,
    });

    const products = [
      { external_ref: 'lavadora-tramontina-1200w', name: 'Lavadora Alta Pressão Tramontina 1200W', price: 8997, quantity: 1 },
    ];
    if (orderBump) {
      products.push({ external_ref: 'garantia-vip-12m', name: 'Garantia Estendida VIP 12 meses', price: 1490, quantity: 1 });
    }
    const diff = amountCents - products.reduce((s, p) => s + p.price * p.quantity, 0);
    if (diff > 0) products.push({ external_ref: 'frete', name: 'Frete', price: diff, quantity: 1 });

    const body = {
      amount:       amountCents,
      description:  `Pedido Bazari #${orderId || Date.now()}`,
      external_id:  `bazari-${orderId || Date.now()}`,
      callback_url: panel.WEBHOOK_URL,
      payer: {
        name:     nome,
        email:    email,
        document: cpf.replace(/\D/g, ''),
        phone:    telefone.replace(/\D/g, ''),
        ...(cep ? { zip_code: cep.replace(/\D/g, '') } : {}),
      },
      products,
      // UTM tracking passado pelo frontend
      ...(utm_source   ? { utm_source }   : {}),
      ...(utm_campaign ? { utm_campaign } : {}),
      ...(utm_medium   ? { utm_medium }   : {}),
      ...(utm_content  ? { utm_content }  : {}),
      ...(utm_term     ? { utm_term }     : {}),
      ...(src          ? { src }          : {}),
      ...(sck          ? { sck }          : {}),
    };

    console.log('[Veno API] Criando cobrança PIX:', JSON.stringify(body));

    const venoRes = await fetch(`${VENO_BASE_URL}/api/v1/pix`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${VENO_API_KEY}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      agent:   httpsAgent,
    });

    const data = await venoRes.json();
    console.log('[Veno API] Resposta:', JSON.stringify(data));

    if (!venoRes.ok) {
      return res.status(venoRes.status).json({ error: data?.message || data?.error || 'Erro ao criar PIX', details: data });
    }

    if (!global._orderCache) global._orderCache = {};
    if (data.id) {
      global._orderCache[data.id] = {
        nome, email, cpf, telefone, cep, total: cleanTotal, orderId, fbc, fbp
      };
    }

    // ── Registra o pedido para o painel /admin ──
    try {
      const novoPedido = await panel.createOrder({
        orderId: orderId || data.external_id || data.id,
        pixId: data.id, txid: data.txid, expiresAt: data.expires_at,
        total: cleanTotal, nome, email, cpf, telefone,
        address: { cep, ...(address && typeof address === 'object' ? address : {}) },
        items: products.map(p => ({ name: p.name, price: p.price / 100, quantity: p.quantity })),
        variant, quantity, shipping, orderBump, vid, fbc, fbp,
        utm: { utm_source, utm_campaign, utm_medium, utm_content, utm_term, src, sck },
      });
      // E-mail "falta só o pagamento" com o código PIX (se ligado em Configurações)
      await panel.notificarPixGeradoPorEmail(novoPedido, data.pix_copy_paste || '');
    } catch (e) {
      console.error('[Painel] Falha ao salvar pedido:', e.message);
    }

    return res.json({
      id:             data.id,
      txid:           data.txid,
      status:         data.status,
      amount:         data.amount,
      pix_copy_paste: data.pix_copy_paste || '',
      qr_code_image:  data.qr_code_image  || '',
      qr_code:        data.qr_code        || '',
      expires_at:     data.expires_at,
      capi_event_id:  eventId,  // retorna ao front para deduplicação
    });

  } catch (err) {
    console.error('[Veno API] Erro interno:', err.message);
    res.status(500).json({ error: 'Erro interno ao criar PIX.', details: err.message });
  }
});

// ─── Status do PIX: helpers ──────────────────────────────────────────────────
// A Veno limita a 100 req/min por token. Cada cliente na tela do PIX consulta o
// status a cada 5s; aqui seguramos para no máx. 1 consulta à Veno a cada 15s por
// PIX (o webhook continua confirmando na hora).
const VENO_CHECK_EVERY_MS = 15000;
const lastVenoCheck = new Map(); // pixId → { at, data }

async function fetchVenoStatus(pixId) {
  const venoRes = await fetch(`${VENO_BASE_URL}/api/v1/pix/${encodeURIComponent(pixId)}/status`, {
    headers: { 'Authorization': `Bearer ${VENO_API_KEY}` },
    agent:   httpsAgent,
  });
  const data = await venoRes.json().catch(() => ({}));
  return { ok: venoRes.ok, httpStatus: venoRes.status, data };
}

function firePurchase(pixId, order, data) {
  const c = order?.customer || {};
  const cached = global._orderCache?.[pixId] || {};
  return sendMetaEvent({
    eventName:  'Purchase',
    eventId:    `purchase-${pixId}`,
    userData:   {
      email:    c.email    || cached.email,
      telefone: c.telefone || cached.telefone,
      nome:     c.nome     || cached.nome,
      cep:      order?.address?.cep || cached.cep,
      orderId:  pixId,
      fbc:      order?.meta?.fbc || cached.fbc,
      fbp:      order?.meta?.fbp || cached.fbp,
    },
    customData: {
      value:        order?.total || cached.total || (data?.amount ? data.amount / 100 : undefined),
      currency:     'BRL',
      content_ids:  ['lavadora-tramontina-1200w'],
      content_type: 'product',
      order_id:     pixId,
    },
    sourceUrl: `${panel.SITE_URL}/obrigado.html`,
  });
}

// Aplica o status oficial da Veno ao pedido. O Purchase da Meta sai uma única vez:
// só quem efetivamente muda o pedido para "pago" dispara.
async function applyVenoStatus(pixId, data, via) {
  if (!data?.status) return;
  const changed = await panel.setGatewayStatus(pixId, data.status, via, data);
  if (panel.normalizeStatus(data.status) !== 'paid') return;
  const order = await panel.getOrderByPix(pixId);
  // Sem pedido salvo: só conta se o PIX foi gerado por esta loja (cache em memória
  // de antes do painel). Um webhook cadastrado no painel da Veno recebe cobranças de
  // TODA a conta — pagamento de outro site não pode virar Purchase nos pixels daqui.
  const ours = order || global._orderCache?.[pixId];
  if (!ours) return;
  const first = order ? changed : !paidPixStore.has(pixId);
  paidPixStore.add(pixId);
  if (first) {
    console.log(`[Veno] ✅ PIX pago (${via}):`, pixId);
    await firePurchase(pixId, order, data);
  }
}

// ─── GET /api/pix/:id/status ──────────────────────────────────────────────────
app.get(['/api/pix/:id/status', '/pix/:id/status'], async (req, res) => {
  try {
    const { id } = req.params;

    if (paidPixStore.has(id)) {
      return res.json({ id, status: 'paid' });
    }
    const stored = await panel.getOrderByPix(id).catch(() => null);
    if (stored && stored.status === 'paid') {
      return res.json({ id, status: 'paid', paid_at: stored.paidAt });
    }

    // Consultou a Veno há pouco → devolve o último resultado sem gastar o limite
    const last = lastVenoCheck.get(id);
    if (last && Date.now() - last.at < VENO_CHECK_EVERY_MS) {
      return res.json(last.data);
    }

    const { ok, httpStatus, data } = await fetchVenoStatus(id);
    if (!ok) return res.status(httpStatus).json({ error: data?.message || 'Erro ao consultar status', details: data });
    lastVenoCheck.set(id, { at: Date.now(), data });
    if (lastVenoCheck.size > 5000) lastVenoCheck.delete(lastVenoCheck.keys().next().value);

    await applyVenoStatus(id, data, 'consulta de status');
    return res.json(data);
  } catch (err) {
    console.error('[Veno API] Erro status:', err.message);
    res.status(500).json({ error: 'Erro ao consultar status.', details: err.message });
  }
});

// ─── POST /api/webhook/veno ───────────────────────────────────────────────────
// Eventos: deposit.created | deposit.paid | deposit.expired | deposit.cancelled |
// deposit.refunded | deposit.chargeback ... (doc: beta.venopayments.com/llms.txt)
//
// A Veno NÃO assina os webhooks. Por isso o corpo recebido é tratado só como um
// aviso: o status real é sempre buscado na API da Veno com a nossa chave. Um POST
// falso nesta URL não consegue marcar pedido como pago nem disparar Purchase.
app.post(['/api/webhook/veno', '/webhook/veno'], async (req, res) => {
  const { event, data } = req.body || {};
  const pixId = data?.id;
  console.log('[Veno Webhook] Evento recebido:', event, pixId);

  if (!pixId || typeof pixId !== 'string' || event === 'deposit.created') {
    return res.status(200).json({ received: true });
  }

  try {
    const check = await fetchVenoStatus(pixId);
    if (!check.ok) {
      // 404 = cobrança não existe nesta conta → ignorar. Outros erros → a Veno tenta de novo.
      if (check.httpStatus === 404) return res.status(200).json({ received: true, ignored: true });
      return res.status(502).json({ error: 'Falha ao confirmar com a Veno' });
    }
    lastVenoCheck.set(pixId, { at: Date.now(), data: check.data });
    await applyVenoStatus(pixId, check.data, 'webhook');
    res.status(200).json({ received: true, status: check.data.status });
  } catch (err) {
    console.error('[Veno Webhook] Erro:', err.message);
    res.status(500).json({ error: 'erro interno' }); // Veno reenvia (até 3 tentativas)
  }
});

// ─── GET /api/pix/:id/simular-pago ────────────────────────────────────────────
// Só funciona logado no painel — antes qualquer pessoa podia marcar um PIX como pago.
app.get(['/api/pix/:id/simular-pago', '/pix/:id/simular-pago'], panel.requireAdmin, async (req, res) => {
  paidPixStore.add(req.params.id);
  await panel.markPaid(req.params.id, 'simulação').catch(() => {});
  console.log('[Veno Simulação] ✅ PIX marcado como PAGO para teste:', req.params.id);
  res.json({ success: true, message: 'Status do PIX alterado para PAID.', id: req.params.id });
});

// ─── POST /api/admin/orders/:id/sync — consulta o status na Veno ─────────────
app.post(['/api/admin/orders/:id/sync', '/admin/orders/:id/sync'], panel.requireAdmin, async (req, res) => {
  try {
    const order = await panel.getOrder(req.params.id);
    if (!order || !order.pixId) return res.status(404).json({ error: 'Pedido sem PIX vinculado' });
    const { ok, data } = await fetchVenoStatus(order.pixId);
    if (!ok) return res.status(502).json({ error: data?.message || 'Erro ao consultar a Veno', details: data });
    const before = order.status;
    await applyVenoStatus(order.pixId, data, 'consulta manual');
    const after = (await panel.getOrder(order.id))?.status;
    res.json({ gatewayStatus: data.status, changed: before !== after });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Exporta o app para o Vercel Serverless
module.exports = app;
