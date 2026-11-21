// api/lib/rastreio.js — gestão de rastreios dentro do painel /admin da loja.
//
// Compartilha os MESMOS dados do site de rastreio (bazari-rastreio): tudo fica
// na chave Redis "rastreios_db" (sem o prefixo bazari:), um JSON com a lista.
// Assim o que for cadastrado aqui aparece no site público, e o que já existe lá
// continua funcionando. A lógica de linha do tempo é a mesma do site de rastreio,
// para os registros ficarem idênticos.
const store = require('./store');

const KEY = 'rastreios_db';

// Opções mostradas no formulário (iguais às do site de rastreio)
const FRETES = [
  'SEDEX Express (3 a 6 dias úteis)',
  'Frete Grátis com Seguro (8 a 12 dias úteis)',
  'PAC Correios',
  'Jadlog Express',
  'Loggi Express',
  'Total Express',
  'Frete Prioritário',
];
const STATUSES = [
  'Pagamento Confirmado',
  'Objeto Postado',
  'Em Trânsito',
  'Na Unidade de Distribuição',
  'Saiu para Entrega',
  'Entregue',
];

// ─── Datas e linha do tempo (copiado do site de rastreio) ─────────────────────
function formatDataRelativa(horasAtras) {
  const d = new Date(Date.now() - horasAtras * 3600000);
  const hoje = new Date();
  const diaD = d.getDate();
  const mesD = String(d.getMonth() + 1).padStart(2, '0');
  const anoD = d.getFullYear();
  const horaStr = String(d.getHours()).padStart(2, '0');
  const minStr = String(d.getMinutes()).padStart(2, '0');
  const diffDias = Math.floor((hoje.setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
  if (diffDias === 0) return `Hoje às ${horaStr}:${minStr}`;
  if (diffDias === 1) return `Ontem às ${horaStr}:${minStr}`;
  return `${String(diaD).padStart(2, '0')}/${mesD}/${anoD} às ${horaStr}:${minStr}`;
}
const formatNowBR = () => formatDataRelativa(0);

function gerarEventosIniciais(status, origem, destino, frete) {
  const orig = origem || 'São Paulo / SP';
  const dest = destino || 'Curitiba / PR';
  const transportadora = frete || 'SEDEX Express';
  const sNorm = (status || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  const evFaturado = { titulo: 'Pagamento confirmado e pedido aprovado', data: formatDataRelativa(1.5), descricao: `Pagamento confirmado e etiqueta de envio ${transportadora} gerada para despacho`, local: `Centro de Logística e Distribuição (${orig})`, tipo: 'faturado' };
  const evPostado = { titulo: 'Objeto postado', data: formatNowBR(), descricao: `Objeto postado na agência dos Correios / Centro Operacional ${transportadora}`, local: `Agência dos Correios (${orig})`, tipo: 'postado' };
  const evRecebidoCTE_Origem = { titulo: 'Objeto recebido na Unidade de Tratamento', data: formatDataRelativa(2), descricao: 'Objeto conferido e integrado para processamento de triagem e despacho interestadual', local: `Centro de Logística e Tratamento (${orig})`, tipo: 'recebido' };
  const evTransitoOrigemDestino = { titulo: 'Objeto em trânsito - por favor aguarde', data: formatNowBR(), descricao: `De Centro de Logística e Tratamento em ${orig} para Unidade de Tratamento e Logística em ${dest}`, local: `Centro de Logística em ${orig}`, tipo: 'transito' };
  const evRecebidoCTE_Destino = { titulo: 'Objeto recebido pelos Correios do Brasil', data: formatDataRelativa(3), descricao: 'Objeto recebido na Unidade de Tratamento e Logística Regional para triagem e encaminhamento local', local: `Unidade de Tratamento em ${dest}`, tipo: 'recebido' };
  const evTransitoCDD = { titulo: 'Objeto em trânsito - por favor aguarde', data: formatNowBR(), descricao: `De Unidade de Tratamento em ${dest} para Unidade de Distribuição Local (CDD)`, local: `Unidade de Tratamento em ${dest}`, tipo: 'transito' };
  const evSaiuEntrega = { titulo: 'Objeto saiu para entrega ao destinatário', data: formatNowBR(), descricao: `Carteiro/Entregador em rota para entrega no endereço do destinatário em ${dest}`, local: `Unidade de Distribuição (${dest})`, tipo: 'entrega' };
  const evEntregue = { titulo: 'Objeto entregue ao destinatário', data: formatNowBR(), descricao: 'Objeto entregue com sucesso para o destinatário', local: dest, tipo: 'entregue' };

  if (sNorm.includes('pagamento') || sNorm.includes('faturado')) {
    evFaturado.data = formatNowBR();
    return [evFaturado];
  } else if (sNorm.includes('postado')) {
    evPostado.data = formatNowBR(); evFaturado.data = formatDataRelativa(1.5);
    return [evPostado, evFaturado];
  } else if (sNorm.includes('entregue')) {
    evEntregue.data = formatNowBR(); evSaiuEntrega.data = formatDataRelativa(2); evTransitoCDD.data = formatDataRelativa(5); evRecebidoCTE_Destino.data = formatDataRelativa(18); evTransitoOrigemDestino.data = formatDataRelativa(26); evRecebidoCTE_Origem.data = formatDataRelativa(30); evPostado.data = formatDataRelativa(32); evFaturado.data = formatDataRelativa(34);
    return [evEntregue, evSaiuEntrega, evTransitoCDD, evRecebidoCTE_Destino, evTransitoOrigemDestino, evRecebidoCTE_Origem, evPostado, evFaturado];
  } else if (sNorm.includes('saiu') || (sNorm.includes('entrega') && !sNorm.includes('entregue'))) {
    evSaiuEntrega.data = formatNowBR(); evTransitoCDD.data = formatDataRelativa(2); evRecebidoCTE_Destino.data = formatDataRelativa(16); evTransitoOrigemDestino.data = formatDataRelativa(24); evRecebidoCTE_Origem.data = formatDataRelativa(28); evPostado.data = formatDataRelativa(30); evFaturado.data = formatDataRelativa(32);
    return [evSaiuEntrega, evTransitoCDD, evRecebidoCTE_Destino, evTransitoOrigemDestino, evRecebidoCTE_Origem, evPostado, evFaturado];
  } else if (sNorm.includes('distribui') || sNorm.includes('unidade')) {
    evTransitoCDD.data = formatNowBR(); evRecebidoCTE_Destino.data = formatDataRelativa(4); evTransitoOrigemDestino.data = formatDataRelativa(18); evRecebidoCTE_Origem.data = formatDataRelativa(24); evPostado.data = formatDataRelativa(26); evFaturado.data = formatDataRelativa(28);
    return [evTransitoCDD, evRecebidoCTE_Destino, evTransitoOrigemDestino, evRecebidoCTE_Origem, evPostado, evFaturado];
  } else {
    evTransitoOrigemDestino.data = formatNowBR(); evRecebidoCTE_Origem.data = formatDataRelativa(2); evPostado.data = formatDataRelativa(4); evFaturado.data = formatDataRelativa(6);
    return [evTransitoOrigemDestino, evRecebidoCTE_Origem, evPostado, evFaturado];
  }
}

function tipoPorStatus(status, tipoInformado) {
  let t = tipoInformado;
  if (!t || t === 'transito') {
    const s = (status || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    if (s.includes('entregue')) t = 'entregue';
    else if (s.includes('saiu') || s.includes('entrega')) t = 'entrega';
    else if (s.includes('postado')) t = 'postado';
    else if (s.includes('pagamento') || s.includes('faturado')) t = 'faturado';
    else if (s.includes('distribui') || s.includes('recebido') || s.includes('unidade')) t = 'recebido';
    else t = 'transito';
  }
  return t;
}

// ─── Progressão automática por tempo (envio sempre de São Paulo) ──────────────
// O status caminha sozinho a partir da data de criação. "Saiu para entrega" cai
// no prazo MÁXIMO do frete (contando só dias úteis) e "Entregue" no dia útil
// seguinte. É uma simulação (não é dado real dos Correios).
const ORIGEM_PADRAO = 'São Paulo / SP';

function maxDiasFrete(frete) {
  const s = String(frete || '');
  const faixa = s.match(/(\d+)\s*a\s*(\d+)\s*dias/i);
  if (faixa) return parseInt(faixa[2], 10);
  const unico = s.match(/(\d+)\s*dias/i);
  if (unico) return parseInt(unico[1], 10);
  if (/gr[aá]tis/i.test(s)) return 12;
  return 6;
}
const ehDiaUtil = d => { const w = d.getDay(); return w >= 1 && w <= 5; };
function addDiasUteis(base, n) {
  const d = new Date(base);
  let add = 0;
  while (add < n) { d.setDate(d.getDate() + 1); if (ehDiaUtil(d)) add++; }
  return d;
}
function emDiaUtil(d) { const x = new Date(d); while (!ehDiaUtil(x)) x.setDate(x.getDate() + 1); return x; }
function comHora(d, h, m) { const x = new Date(d); x.setHours(h, m || 0, 0, 0); return x; }
function rotuloData(d, now) {
  const base = new Date(now); base.setHours(0, 0, 0, 0);
  const dia = new Date(d); dia.setHours(0, 0, 0, 0);
  const diff = Math.round((base - dia) / 86400000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (diff === 0) return `Hoje às ${hh}:${mm}`;
  if (diff === 1) return `Ontem às ${hh}:${mm}`;
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} às ${hh}:${mm}`;
}

function agendaAuto(r) {
  const orig = ORIGEM_PADRAO;
  const dest = r.cidadeDestino || 'Destino';
  const frete = r.frete || 'SEDEX Express';
  const max = Math.max(2, maxDiasFrete(frete));
  const t0 = new Date(r.criadoEm || Date.now());
  const dia = f => comHora(addDiasUteis(t0, Math.round(f * max)), 0, 0);
  const saiu = comHora(emDiaUtil(addDiasUteis(t0, max)), 9, 30);
  const entregue = comHora(addDiasUteis(saiu, 1), 15, 10);
  return [
    { date: new Date(t0.getTime() + 5 * 60000), status: 'Pagamento Confirmado', titulo: 'Pagamento confirmado e pedido aprovado', descricao: `Pagamento confirmado e etiqueta de envio ${frete} gerada para despacho`, local: `Centro de Logística e Distribuição (${orig})`, tipo: 'faturado' },
    { date: new Date(t0.getTime() + 40 * 60000), status: 'Objeto Postado', titulo: 'Objeto postado', descricao: `Objeto postado no Centro Operacional ${frete}`, local: `Agência dos Correios (${orig})`, tipo: 'postado' },
    { date: comHora(dia(0.2), 20, 10), status: 'Em Trânsito', titulo: 'Objeto recebido na Unidade de Tratamento', descricao: 'Objeto conferido e integrado para triagem e despacho interestadual', local: `Centro de Logística e Tratamento (${orig})`, tipo: 'recebido' },
    { date: comHora(dia(0.4), 8, 0), status: 'Em Trânsito', titulo: 'Objeto em trânsito - por favor aguarde', descricao: `De Centro de Logística e Tratamento em ${orig} para Unidade de Tratamento em ${dest}`, local: `Centro de Logística em ${orig}`, tipo: 'transito' },
    { date: comHora(dia(0.65), 12, 30), status: 'Em Trânsito', titulo: 'Objeto recebido pelos Correios do Brasil', descricao: 'Objeto recebido na Unidade de Tratamento e Logística Regional para encaminhamento local', local: `Unidade de Tratamento em ${dest}`, tipo: 'recebido' },
    { date: comHora(dia(0.85), 9, 0), status: 'Na Unidade de Distribuição', titulo: 'Objeto em trânsito - por favor aguarde', descricao: `De Unidade de Tratamento em ${dest} para Unidade de Distribuição Local (CDD)`, local: `Unidade de Tratamento em ${dest}`, tipo: 'transito' },
    { date: saiu, status: 'Saiu para Entrega', titulo: 'Objeto saiu para entrega ao destinatário', descricao: `Carteiro/Entregador em rota para entrega no endereço do destinatário em ${dest}`, local: `Unidade de Distribuição (${dest})`, tipo: 'entrega' },
    { date: entregue, status: 'Entregue', titulo: 'Objeto entregue ao destinatário', descricao: 'Objeto entregue com sucesso para o destinatário', local: dest, tipo: 'entregue' },
  ];
}

// Calcula o estado ATUAL de um rastreio automático (status + linha do tempo até agora)
function computarAuto(r, now = Date.now()) {
  const agenda = agendaAuto(r);
  const ocorridos = agenda.filter(e => e.date.getTime() <= now);
  const visiveis = ocorridos.length ? ocorridos : [agenda[0]];
  const atual = visiveis[visiveis.length - 1];
  const eventos = visiveis.slice().reverse().map(e => ({
    titulo: e.titulo, data: rotuloData(e.date, now), descricao: e.descricao, local: e.local, tipo: e.tipo,
  }));
  return { ...r, cidadeOrigem: ORIGEM_PADRAO, status: atual.status, eventos };
}

// Versão para exibir (público e painel): automáticos são recalculados pelo tempo.
const paraExibir = (r, now) => (r && r.auto ? computarAuto(r, now) : r);

// ─── Persistência (chave crua compartilhada) ──────────────────────────────────
async function carregar() {
  const lista = await store.getRawJSON(KEY);
  return Array.isArray(lista) ? lista : [];
}
const salvar = lista => store.setRawJSON(KEY, lista);

async function criar(data) {
  const origemFinal = (data.cidadeOrigem || 'São Paulo / SP').trim();
  const destinoFinal = (data.cidadeDestino || '').trim();
  if (!data.cliente || !destinoFinal) {
    const err = new Error('Informe pelo menos o cliente e a cidade de destino.');
    err.code = 400; throw err;
  }
  let codigo = (data.codigo || '').trim().toUpperCase();
  if (!codigo) codigo = `BR${Math.floor(100000000 + Math.random() * 900000000)}BZ`;

  const lista = await carregar();
  if (lista.some(i => (i.codigo || '').toUpperCase() === codigo)) {
    const err = new Error('Já existe um rastreio com esse código.');
    err.code = 409; throw err;
  }
  const auto = !!data.auto;
  const statusFinal = data.status || 'Em Trânsito';
  const novo = {
    id: codigo, codigo,
    cliente: data.cliente.trim(),
    cpf: (data.cpf || '').trim(),
    produto: (data.produto || 'Lavadora de Alta Pressão Tramontina 1200W').trim(),
    quantidade: Number(data.quantidade) || 1,
    frete: (data.frete || 'SEDEX Express').trim(),
    cidadeOrigem: auto ? ORIGEM_PADRAO : origemFinal,
    cidadeDestino: destinoFinal,
    status: statusFinal,
    criadoEm: new Date().toISOString(),
    auto,
    eventos: [],
  };
  if (auto) {
    // Guarda um retrato inicial (o painel e o público recalculam ao vivo pelo tempo)
    const snap = computarAuto(novo);
    novo.status = snap.status; novo.eventos = snap.eventos;
  } else {
    novo.eventos = (data.eventos && data.eventos.length)
      ? data.eventos
      : gerarEventosIniciais(statusFinal, origemFinal, destinoFinal, data.frete);
  }
  lista.unshift(novo);
  await salvar(lista);
  return auto ? computarAuto(novo) : novo;
}

async function atualizar(codigo, data) {
  const alvo = String(codigo).trim().toUpperCase();
  const lista = await carregar();
  const idx = lista.findIndex(i => (i.codigo || '').toUpperCase() === alvo);
  if (idx === -1) { const err = new Error('Rastreio não encontrado.'); err.code = 404; throw err; }
  const item = lista[idx];
  const eraAuto = !!item.auto;
  const querAuto = data.auto === undefined ? eraAuto : !!data.auto;

  // Campos editáveis de cadastro (valem nos dois modos)
  ['cliente', 'cpf', 'produto', 'frete', 'cidadeDestino'].forEach(k => {
    if (data[k] !== undefined && data[k] !== '') item[k] = data[k];
  });
  if (data.quantidade) item.quantidade = Number(data.quantidade);

  if (querAuto) {
    // Automático: origem fixa SP, sem evento manual — o estado é recalculado pelo tempo
    item.auto = true;
    item.cidadeOrigem = ORIGEM_PADRAO;
    const snap = computarAuto(item);
    item.status = snap.status; item.eventos = snap.eventos;
  } else if (eraAuto && !querAuto) {
    // Saiu do automático → congela no estado atual e passa a ser manual
    const snap = computarAuto(item);
    item.auto = false;
    item.status = snap.status;
    item.eventos = snap.eventos;
  } else {
    // Manual: atualiza status e adiciona etapa à linha do tempo
    if (data.cidadeOrigem !== undefined && data.cidadeOrigem !== '') item.cidadeOrigem = data.cidadeOrigem;
    if (data.status !== undefined && data.status !== '') item.status = data.status;
    if (data.novoEvento) {
      if (!item.eventos) item.eventos = [];
      item.eventos.unshift({
        titulo: data.novoEvento.titulo || `Status atualizado para ${item.status}`,
        data: data.novoEvento.data || formatNowBR(),
        descricao: data.novoEvento.descricao || `Movimentação registrada em direção a ${item.cidadeDestino}`,
        local: data.novoEvento.local || item.cidadeDestino,
        tipo: tipoPorStatus(item.status, data.novoEvento.tipo),
      });
    }
  }
  lista[idx] = item;
  await salvar(lista);
  return item.auto ? computarAuto(item) : item;
}

async function excluir(codigo) {
  const alvo = String(codigo).trim().toUpperCase();
  const lista = await carregar();
  const nova = lista.filter(i => (i.codigo || '').toUpperCase() !== alvo);
  if (nova.length === lista.length) { const err = new Error('Rastreio não encontrado.'); err.code = 404; throw err; }
  await salvar(nova);
  return true;
}

// ─── Emissão automática a partir de um pedido pago ────────────────────────────
function freteDoPedido(shipping) {
  if (shipping === 'free') return 'Frete Grátis com Seguro (8 a 12 dias úteis)';
  return 'SEDEX Express (3 a 6 dias úteis)';
}

// Cria um rastreio automático para um pedido. Idempotente: se já existe o código
// (BR<nº do pedido>BZ), não cria de novo.
async function emitirDoPedido(order) {
  if (!order) return null;
  const num = String(order.id || '').replace(/\D/g, '') || String(Date.now());
  const codigo = `BR${num}BZ`;
  const lista = await carregar();
  const existe = lista.find(i => (i.codigo || '').toUpperCase() === codigo);
  if (existe) return existe;
  const dest = [order.address?.city, order.address?.state].filter(Boolean).join(' / ') || 'A definir';
  return criar({
    codigo,
    cliente: order.customer?.nome || 'Cliente',
    cpf: order.customer?.cpf || '',
    produto: (order.items && order.items[0] && order.items[0].name) || 'Lavadora de Alta Pressão Tramontina 1200W',
    quantidade: order.quantity || 1,
    frete: freteDoPedido(order.shipping),
    cidadeDestino: dest,
    auto: true,
  });
}

function stats(lista) {
  const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  let transito = 0, saiu = 0, entregue = 0;
  lista.forEach(i => {
    const s = norm(i.status);
    if (s.includes('entregue')) entregue++;
    else if (s.includes('saiu') || (s.includes('entrega') && !s.includes('entregue'))) saiu++;
    else transito++;
  });
  return { total: lista.length, transito, saiu, entregue };
}

// ─── Rotas do painel (protegidas pelo login da loja) ──────────────────────────
async function buscarPublico(busca) {
  const termo = String(busca || '').trim().toUpperCase();
  const digitos = termo.replace(/\D/g, '');
  const lista = await carregar();
  return lista.find(i => {
    const porCodigo = i.codigo && i.codigo.toUpperCase() === termo;
    const porCpf = i.cpf && i.cpf.replace(/\D/g, '') === digitos && digitos.length >= 8;
    return porCodigo || porCpf;
  }) || null;
}

function register(app, requireAdmin) {
  const both = p => [`/api${p}`, p];

  // Busca PÚBLICA (o cliente rastreia por código ou CPF) — sem login.
  // Precisa vir antes das rotas estáticas do server.
  app.get(both('/rastreios/:busca'), async (req, res) => {
    try {
      const achado = await buscarPublico(req.params.busca);
      if (!achado) return res.status(404).json({ error: 'Rastreio não encontrado' });
      res.json(paraExibir(achado));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get(both('/admin/rastreios'), requireAdmin, async (req, res) => {
    try {
      const now = Date.now();
      const lista = (await carregar()).map(r => paraExibir(r, now)); // status ao vivo
      const q = String(req.query.q || '').trim().toLowerCase();
      const qd = q.replace(/\D/g, '');
      const status = String(req.query.status || '');
      let out = lista;
      if (status) out = out.filter(i => (i.status || '') === status);
      if (q) out = out.filter(i =>
        [i.codigo, i.cliente, i.produto, i.cidadeDestino, i.cidadeOrigem].some(v => String(v || '').toLowerCase().includes(q))
        || (qd.length >= 3 && String(i.cpf || '').replace(/\D/g, '').includes(qd)));
      res.json({ rastreios: out, stats: stats(lista), fretes: FRETES, statuses: STATUSES, storage: store.mode });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post(both('/admin/rastreios'), requireAdmin, async (req, res) => {
    try { res.status(201).json(await criar(req.body || {})); }
    catch (e) { res.status(e.code || 500).json({ error: e.message }); }
  });

  app.put(both('/admin/rastreios/:codigo'), requireAdmin, async (req, res) => {
    try { res.json(await atualizar(req.params.codigo, req.body || {})); }
    catch (e) { res.status(e.code || 500).json({ error: e.message }); }
  });

  app.delete(both('/admin/rastreios/:codigo'), requireAdmin, async (req, res) => {
    try { await excluir(req.params.codigo); res.json({ success: true }); }
    catch (e) { res.status(e.code || 500).json({ error: e.message }); }
  });
}

module.exports = { register, carregar, criar, atualizar, excluir, stats, computarAuto, maxDiasFrete, emitirDoPedido, FRETES, STATUSES };
