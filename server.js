// server.js — Bazari backend proxy para Veno Payments PIX + Meta CAPI Dual Pixel
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const https   = require('https');
const crypto  = require('crypto');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Servir arquivos estáticos da raiz
app.use(express.static(__dirname));

// ─── Config Veno ─────────────────────────────────────────────────────────────
const VENO_API_KEY  = 'veno_live_e5cb2d9a239405e05b1cf3440244c62785437adca507422a';
const VENO_BASE_URL = 'https://beta.venopayments.com';
const httpsAgent    = new https.Agent({ rejectUnauthorized: false });

// ─── Config Meta Pixels & CAPI Tokens ─────────────────────────────────────────
const META_PIXELS = [
  {
    id: '1448868326836788',
    token: 'EAGYyaNTSuUEBTACb7nM970YrUtqZC0qZAt9wwMlRg1spEZCeaCGqmj1PdqnkjkoZBcoXnBgACZAODU0jZAuxu6jZBHzZB0S8GrbZBVThZAeRUxk3HeAhfpXq6aA7yelLCZAxT2PaTfZCwo2ZANxW9VniySlsy4UoEFCqmJv18HHlntDVVQTnFhJdZB4du3FqcQo4ZCAgHeoBgZDZD'
  },
  {
    id: '29370137919281276',
    token: 'EAAQOKCi5psUBTDQlZAZBHt9GZCkrUeIIWtq0SxkEvjrM1jKZCiiGAo4CMHRnBZBdVaTyPsaq8hV8JhR3aqH8FdEGVFpzjLs68fIoRofXVwG9DEBZC6KR84oRXu7C05rzzWKt2qPL1bXpZAOKq6eUgvXjg9XVwX7o2nRaJUuwYHAlpbVaSGk1dhpUlMqioUeA7ZBXlQZDZD'
  },
  {
    id: '1715304620163972',
    token: 'EAAgyZC8rARtcBTAsPrw6gk9Xa0fQFCzUtplPNHt8nMKaLX2ewB8D8ff1fPacRVLshHIfNwRzo6PbwV3txEsdubOOiqBDdvpkW9iE3MCcs4ibonAWYTvLmZBDXwXEd5kZA5DH9lTivrOco1R0sZCiAUOZB1PYLq5eT0xjnA1cSJV1dcZCNol2Hq9hmBNklmNhJCPAZDZD'
  }
];

// Cache em memória
const paidPixStore = new Set();
if (!global._orderCache) global._orderCache = {};

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
        event_source_url: sourceUrl || 'https://bazari-nine.vercel.app/',
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

// ─── Rotas Estáticas Explícitas ───────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/checkout.html', (req, res) => res.sendFile(path.join(__dirname, 'checkout.html')));
app.get('/pagar.html', (req, res) => res.sendFile(path.join(__dirname, 'pagar.html')));
app.get('/obrigado.html', (req, res) => res.sendFile(path.join(__dirname, 'obrigado.html')));
app.get('/rastreio.html', (req, res) => res.sendFile(path.join(__dirname, 'rastreio.html')));

// ─── POST /api/pix/criar ──────────────────────────────────────────────────────
app.post(['/api/pix/criar', '/pix/criar'], async (req, res) => {
  try {
    const { nome, email, cpf, telefone, cep, total, orderBump, orderId, fbc, fbp,
            utm_source, utm_campaign, utm_medium, utm_content, utm_term, src, sck } = req.body || {};

    if (!nome || !email || !cpf || !telefone || !total) {
      return res.status(400).json({ error: 'Campos obrigatórios faltando.' });
    }

    const cleanTotal  = typeof total === 'string' ? parseFloat(total.replace(',', '.')) : Number(total);
    const amountCents = Math.round(cleanTotal * 100);
    const clientIp    = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '';
    const clientUa    = req.headers['user-agent'] || '';
    const eventId     = `initiate-${orderId || Date.now()}`;

    // Dispara InitiateCheckout no CAPI para ambos os pixels
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
      sourceUrl: 'https://bazari-nine.vercel.app/checkout.html',
    });

    const products = [
      { external_ref: 'lavadora-tramontina-1200w', name: 'Lavadora Alta Pressão Tramontina 1200W', price: 6988, quantity: 1 },
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
      callback_url: 'https://bazari-nine.vercel.app/api/webhook/veno',
      payer: {
        name:     nome,
        email:    email,
        document: cpf.replace(/\D/g, ''),
        phone:    telefone.replace(/\D/g, ''),
        ...(cep ? { zip_code: cep.replace(/\D/g, '') } : {}),
      },
      products,
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

    if (data.id) {
      global._orderCache[data.id] = {
        nome, email, cpf, telefone, cep, total: cleanTotal, orderId, fbc, fbp
      };
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
      capi_event_id:  eventId,
    });

  } catch (err) {
    console.error('[Veno API] Erro interno:', err.message);
    res.status(500).json({ error: 'Erro interno ao criar PIX.', details: err.message });
  }
});

// ─── GET /api/pix/:id/status ──────────────────────────────────────────────────
app.get(['/api/pix/:id/status', '/pix/:id/status'], async (req, res) => {
  try {
    const { id } = req.params;

    if (paidPixStore.has(id)) {
      return res.json({ id, status: 'paid', paid_at: new Date().toISOString() });
    }

    const venoRes = await fetch(`${VENO_BASE_URL}/api/v1/pix/${id}/status`, {
      headers: { 'Authorization': `Bearer ${VENO_API_KEY}` },
      agent:   httpsAgent,
    });
    const data = await venoRes.json();
    if (!venoRes.ok) return res.status(venoRes.status).json({ error: data?.message || 'Erro ao consultar status', details: data });

    if (data.status === 'paid' && !paidPixStore.has(id)) {
      paidPixStore.add(id);

      // Dispara Purchase no CAPI via polling para ambos os pixels
      const cached = global._orderCache?.[id];
      sendMetaEvent({
        eventName:  'Purchase',
        eventId:    `purchase-${id}`,
        userData:   cached ? { email: cached.email, telefone: cached.telefone, nome: cached.nome, cep: cached.cep, orderId: id, fbc: cached.fbc, fbp: cached.fbp } : {},
        customData: {
          value:        cached ? cached.total : (data.amount / 100),
          currency:     'BRL',
          content_ids:  ['lavadora-tramontina-1200w'],
          content_type: 'product',
          order_id:     id,
        },
        sourceUrl: 'https://bazari-nine.vercel.app/obrigado.html',
      });
    }

    return res.json(data);
  } catch (err) {
    console.error('[Veno API] Erro status:', err.message);
    res.status(500).json({ error: 'Erro ao consultar status.', details: err.message });
  }
});

// ─── POST /api/webhook/veno ───────────────────────────────────────────────────
app.post(['/api/webhook/veno', '/webhook/veno'], async (req, res) => {
  const { event, data } = req.body || {};
  console.log('[Veno Webhook] Evento recebido:', event, data);

  if (data && data.id && (event === 'deposit.paid' || data.status === 'paid')) {
    if (!paidPixStore.has(data.id)) {
      paidPixStore.add(data.id);
      console.log('[Veno Webhook] ✅ PIX confirmado como pago:', data.id);

      // Dispara Purchase no CAPI via webhook para ambos os pixels
      const cached = global._orderCache?.[data.id];
      await sendMetaEvent({
        eventName:  'Purchase',
        eventId:    `purchase-${data.id}`,
        userData:   {
          email:    data.payer?.email || cached?.email,
          telefone: data.payer?.phone || cached?.telefone,
          nome:     data.payer?.name  || cached?.nome,
          cep:      data.payer?.zip_code || cached?.cep,
          orderId:  data.id,
          fbc:      cached?.fbc,
          fbp:      cached?.fbp,
        },
        customData: {
          value:        data.amount ? data.amount / 100 : cached?.total,
          currency:     'BRL',
          content_ids:  ['lavadora-tramontina-1200w'],
          content_type: 'product',
          order_id:     data.id,
        },
        sourceUrl: 'https://bazari-nine.vercel.app/obrigado.html',
      });
    }
  }

  res.status(200).json({ received: true });
});

// ─── GET /api/pix/:id/simular-pago ────────────────────────────────────────────
app.get(['/api/pix/:id/simular-pago', '/pix/:id/simular-pago'], (req, res) => {
  paidPixStore.add(req.params.id);
  console.log('[Veno Simulação] ✅ PIX marcado como PAGO para teste:', req.params.id);
  res.json({ success: true, message: 'Status do PIX alterado para PAID.', id: req.params.id });
});

// ─── Iniciar Localmente se executado diretamente ──────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3002;
  app.listen(PORT, () => {
    console.log(`\n🚀 Bazari backend em http://localhost:${PORT}`);
    console.log(`   PIX: POST http://localhost:${PORT}/api/pix/criar\n`);
  });
}

module.exports = app;
