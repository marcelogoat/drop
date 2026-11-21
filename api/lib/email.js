// api/lib/email.js — envio de e-mails transacionais via Resend.
//
// A chave do Resend vem da variável de ambiente RESEND_API_KEY (.env local / Vercel).
const fetch = require('node-fetch');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';

// Remetente. Sem domínio verificado no Resend, use o remetente de teste
// (onboarding@resend.dev), que só entrega para o e-mail dono da conta Resend.
// Depois de verificar seu domínio, defina EMAIL_FROM, ex.: "Bazari <pedidos@seudominio.com>".
const EMAIL_FROM  = process.env.EMAIL_FROM  || 'Bazari <pedidos@bazari.pro>';
const EMAIL_REPLY = process.env.EMAIL_REPLY || 'contato@bazari.pro';

const configurado = () => Boolean(RESEND_API_KEY);

async function enviar({ to, subject, html, text }) {
  if (!configurado()) return { ok: false, skipped: true, motivo: 'RESEND_API_KEY ausente' };
  if (!to) return { ok: false, motivo: 'destinatário vazio' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: EMAIL_FROM, to: [to], reply_to: EMAIL_REPLY, subject, html, ...(text ? { text } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, motivo: data?.message || data?.name || 'falha no envio', data };
    return { ok: true, id: data.id };
  } catch (err) {
    return { ok: false, motivo: err.message };
  }
}

// ─── Modelos ──────────────────────────────────────────────────────────────────
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = n => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function layout(siteUrl, titulo, corpoHtml) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#F3F4F6;font-family:Arial,Helvetica,sans-serif;color:#1A1A1A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid #E5E7EB;">
        <tr><td style="background:#1B3A4B;padding:22px 28px;">
          <img src="${esc(siteUrl)}/logo-white.png" alt="Bazari" height="30" style="height:30px;display:block;">
        </td></tr>
        <tr><td style="padding:28px;">
          <h1 style="margin:0 0 14px;font-size:20px;color:#111827;">${titulo}</h1>
          ${corpoHtml}
        </td></tr>
        <tr><td style="padding:18px 28px;background:#F8F9FC;border-top:1px solid #E5E7EB;font-size:12px;color:#6B7280;line-height:1.6;">
          Precisa de ajuda? WhatsApp (11) 9 8302-0542 · contato@bazari.com.br<br>
          Bazari · CNPJ 11.855.677/0001-28 · Envio de São Paulo / SP
        </td></tr>
      </table>
      <div style="max-width:520px;margin:12px auto 0;font-size:11px;color:#9CA3AF;text-align:center;">Você recebeu este e-mail porque fez uma compra na Bazari.</div>
    </td></tr>
  </table>
</body></html>`;
}

function pagamentoConfirmado(order, rastreioCodigo, siteUrl) {
  const nome = (order.customer?.nome || 'Cliente').trim().split(' ')[0];
  const itens = (order.items && order.items.length ? order.items : [{ name: order.produto || 'Produto', price: order.total, quantity: order.quantity || 1 }]);
  const linhas = itens.map(i => `<tr>
    <td style="padding:8px 0;font-size:14px;color:#374151;">${esc(i.name)}${i.quantity > 1 ? ` <span style="color:#6B7280;">× ${i.quantity}</span>` : ''}</td>
    <td style="padding:8px 0;font-size:14px;color:#374151;text-align:right;white-space:nowrap;">${brl(i.price)}</td></tr>`).join('');
  const rastreioUrl = `${siteUrl}/rastreio.html?codigo=${encodeURIComponent(rastreioCodigo || '')}`;
  const prazo = /gr[aá]tis/i.test(order.shipping === 'free' ? 'gratis' : (order.frete || '')) || order.shipping === 'free' ? '8 a 12 dias úteis' : '3 a 6 dias úteis';

  const corpo = `
    <p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#374151;">Olá, <b>${esc(nome)}</b>! Recebemos o pagamento do seu pedido e já estamos preparando o envio. 🎉</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 18px;border:1px solid #E5E7EB;border-radius:12px;">
      <tr><td style="padding:16px 18px;">
        <div style="font-size:12px;color:#6B7280;margin-bottom:6px;">Pedido <b style="color:#111827;">#${esc(order.id)}</b></div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${linhas}
          <tr><td style="padding:12px 0 0;border-top:1px solid #EEF0F4;font-size:15px;font-weight:bold;color:#111827;">Total pago</td>
          <td style="padding:12px 0 0;border-top:1px solid #EEF0F4;font-size:15px;font-weight:bold;color:#0A734D;text-align:right;">${brl(order.total)}</td></tr>
        </table>
      </td></tr>
    </table>
    ${rastreioCodigo ? `
    <div style="background:#E8F5EE;border-radius:12px;padding:16px 18px;margin:0 0 18px;">
      <div style="font-size:12px;color:#0A734D;margin-bottom:4px;">Código de rastreio</div>
      <div style="font-size:18px;font-weight:bold;color:#111827;letter-spacing:.5px;">${esc(rastreioCodigo)}</div>
      <div style="font-size:12.5px;color:#4B5563;margin-top:4px;">Entrega estimada em ${prazo} · envio de São Paulo.</div>
    </div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 8px;"><tr><td style="border-radius:10px;background:#0A734D;">
      <a href="${esc(rastreioUrl)}" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:bold;color:#FFFFFF;text-decoration:none;">Rastrear meu pedido</a>
    </td></tr></table>` : ''}
    <p style="margin:16px 0 0;font-size:13px;color:#6B7280;line-height:1.6;">Qualquer dúvida, é só responder este e-mail ou chamar no WhatsApp.</p>`;

  return { subject: `Pagamento confirmado — Pedido #${order.id}`, html: layout(siteUrl, 'Pagamento confirmado ✅', corpo) };
}

function pixGerado(order, pixCode, siteUrl) {
  const nome = (order.customer?.nome || 'Cliente').trim().split(' ')[0];
  const itens = (order.items && order.items.length ? order.items : [{ name: order.produto || 'Produto', quantity: order.quantity || 1 }]);
  const nItens = itens.reduce((s, i) => s + (i.quantity || 1), 0);
  const nomeProduto = itens[0] ? itens[0].name : 'Produto';
  const totalStr = Number(order.total || 0).toFixed(2).replace('.', ',');
  const pagarUrl = `${siteUrl}/pagar.html?pedido=${encodeURIComponent(order.id)}&total=${encodeURIComponent(totalStr)}&pix_id=${encodeURIComponent(order.pixId || '')}&pix_code=${encodeURIComponent(pixCode || '')}`;

  const corpo = `
    <p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#374151;">Oi, <b>${esc(nome)}</b>! Seu pedido foi registrado e agora falta só o pagamento via PIX para a gente começar a preparar o envio.</p>

    <div style="font-size:12px;color:#6B7280;margin:18px 0 6px;font-weight:bold;letter-spacing:.3px;">CÓDIGO PIX (COPIA E COLA)</div>
    <div style="border:1px dashed #0A734D;background:#F6FBF8;border-radius:12px;padding:14px 16px;font-family:'Courier New',monospace;font-size:12.5px;color:#1B3A4B;word-break:break-all;line-height:1.5;">${esc(pixCode || '')}</div>
    <p style="margin:8px 0 18px;font-size:12.5px;color:#6B7280;">Copie o código acima e cole no <b>PIX Copia e Cola</b> do app do seu banco.</p>

    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;"><tr><td style="border-radius:10px;background:#0A734D;">
      <a href="${esc(pagarUrl)}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:bold;color:#FFFFFF;text-decoration:none;">Abrir meu PIX</a>
    </td></tr></table>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border:1px solid #E5E7EB;border-radius:12px;">
      <tr><td style="padding:14px 18px;font-size:13.5px;color:#374151;border-bottom:1px solid #EEF0F4;"><span style="color:#6B7280;">Pedido</span> &nbsp; <b>#${esc(order.id)}</b></td></tr>
      <tr><td style="padding:14px 18px;font-size:13.5px;color:#374151;border-bottom:1px solid #EEF0F4;"><span style="color:#6B7280;">Produto</span> &nbsp; ${esc(nomeProduto)} <span style="color:#6B7280;">(${nItens} ${nItens > 1 ? 'itens' : 'item'})</span></td></tr>
      <tr><td style="padding:14px 18px;font-size:15px;color:#111827;"><span style="color:#6B7280;font-size:13.5px;">Valor total</span> &nbsp; <b style="color:#0A734D;">${brl(order.total)}</b></td></tr>
    </table>

    <div style="font-size:14px;font-weight:bold;color:#111827;margin:0 0 8px;">Em segundos você paga:</div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 6px;">
      ${['Entre no aplicativo do seu banco', 'Escolha a área de PIX', 'Toque em "Copia e Cola" e cole o código'].map((t, i) => `
      <tr><td style="padding:3px 10px 3px 0;vertical-align:top;"><div style="width:22px;height:22px;border-radius:50%;background:#E8F5EE;color:#0A734D;font-size:12px;font-weight:bold;text-align:center;line-height:22px;">${i + 1}</div></td>
      <td style="padding:3px 0;font-size:14px;color:#374151;line-height:22px;">${t}</td></tr>`).join('')}
    </table>
    <p style="margin:12px 0 0;font-size:13px;color:#6B7280;line-height:1.6;">O pagamento é instantâneo — em poucos minutos o seu pedido é atualizado automaticamente.</p>`;

  return { subject: `Falta só o pagamento — Pedido #${order.id}`, html: layout(siteUrl, 'Falta só o pagamento', corpo) };
}

module.exports = { enviar, configurado, pagamentoConfirmado, pixGerado, EMAIL_FROM };
