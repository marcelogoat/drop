// server.js — Bazari backend proxy para Veno Payments PIX
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const https   = require('https');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ─── Config ───────────────────────────────────────────────────────────────────
const VENO_API_KEY  = 'veno_live_e5cb2d9a239405e05b1cf3440244c62785437adca507422a';
const VENO_BASE_URL = 'https://beta.venopayments.com';
const httpsAgent    = new https.Agent({ rejectUnauthorized: false });
// Armazenamento em memória para status pago (webhooks e simulações)
const paidPixStore = new Set();


// ─── POST /api/pix/criar ──────────────────────────────────────────────────────
app.post('/api/pix/criar', async (req, res) => {
  try {
    const { nome, email, cpf, telefone, cep, total, orderBump, orderId } = req.body;

    if (!nome || !email || !cpf || !telefone || !total) {
      return res.status(400).json({ error: 'Campos obrigatórios faltando.' });
    }

    const cleanTotal = typeof total === 'string' ? parseFloat(total.replace(',', '.')) : Number(total);
    const amountCents = Math.round(cleanTotal * 100);

    const products = [
      { external_ref: 'lavadora-tramontina-1200w', name: 'Lavadora Alta Pressão Tramontina 1200W', price: 6988, quantity: 1 },
    ];
    if (orderBump) {
      products.push({ external_ref: 'garantia-vip-12m', name: 'Garantia Estendida VIP 12 meses', price: 1490, quantity: 1 });
    }
    const diff = amountCents - products.reduce((s, p) => s + p.price * p.quantity, 0);
    if (diff > 0) products.push({ external_ref: 'frete', name: 'Frete', price: diff, quantity: 1 });

    const body = {
      amount:      amountCents,
      description: `Pedido Bazari #${orderId || Date.now()}`,
      external_id: `bazari-${orderId || Date.now()}`,
      payer: {
        name:     nome,
        email:    email,
        document: cpf.replace(/\D/g, ''),
        phone:    telefone.replace(/\D/g, ''),
        ...(cep ? { zip_code: cep.replace(/\D/g, '') } : {}),
      },
      products,
    };

    console.log('[Veno] POST /api/v1/pix', JSON.stringify(body));

    const venoRes = await fetch(`${VENO_BASE_URL}/api/v1/pix`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${VENO_API_KEY}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      agent:   httpsAgent,
    });

    const data = await venoRes.json();
    console.log('[Veno] Resposta criação:', JSON.stringify(data));

    if (!venoRes.ok) {
      return res.status(venoRes.status).json({ error: data?.message || data?.error || 'Erro ao criar PIX', details: data });
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
    });

  } catch (err) {
    console.error('[Veno] Erro criação:', err.message);
    res.status(500).json({ error: 'Erro interno.', details: err.message });
  }
});

// ─── GET /api/pix/:id/status ──────────────────────────────────────────────────
app.get('/api/pix/:id/status', async (req, res) => {
  try {
    const { id } = req.params;

    // Se já foi marcado como pago por webhook ou simulação de teste
    if (paidPixStore.has(id)) {
      return res.json({ id, status: 'paid', paid_at: new Date().toISOString() });
    }

    const venoRes = await fetch(`${VENO_BASE_URL}/api/v1/pix/${id}/status`, {
      headers: { 'Authorization': `Bearer ${VENO_API_KEY}` },
      agent:   httpsAgent,
    });
    const data = await venoRes.json();
    if (!venoRes.ok) return res.status(venoRes.status).json({ error: data?.message || 'Erro ao consultar status', details: data });

    if (data.status === 'paid') {
      paidPixStore.add(id);
    }
    return res.json(data);
  } catch (err) {
    console.error('[Veno] Erro status:', err.message);
    res.status(500).json({ error: 'Erro ao consultar status.', details: err.message });
  }
});

// ─── POST /api/webhook/veno ───────────────────────────────────────────────────
app.post('/api/webhook/veno', (req, res) => {
  const { event, data } = req.body || {};
  console.log('[Veno Webhook] Evento recebido:', event, data);
  if (data && data.id && (event === 'deposit.paid' || data.status === 'paid')) {
    paidPixStore.add(data.id);
    console.log('[Veno Webhook] ✅ PIX confirmado como pago:', data.id);
  }
  res.status(200).json({ received: true });
});

// ─── GET /api/pix/:id/simular-pago (Para testes rápidos de homologação) ────────
app.get('/api/pix/:id/simular-pago', (req, res) => {
  paidPixStore.add(req.params.id);
  console.log('[Veno Simulação] ✅ PIX marcado como PAGO para teste:', req.params.id);
  res.json({ success: true, message: 'Status do PIX alterado para PAID.', id: req.params.id });
});

// ─── Iniciar ──────────────────────────────────────────────────────────────────
const PORT = 3002;
app.listen(PORT, () => {
  console.log(`\n🚀 Bazari backend em http://localhost:${PORT}`);
  console.log(`   PIX: POST http://localhost:${PORT}/api/pix/criar\n`);
});
