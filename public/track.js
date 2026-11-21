// track.js — avisa o painel /admin de quem está no site e em qual seção.
// Uso: <script src="track.js" data-section="lp|checkout|pix|obrigado|rastreio" defer></script>
(function () {
  var script = document.currentScript;
  var section = (script && script.getAttribute('data-section')) || 'lp';
  var HEARTBEAT_MS = 15000;

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  // Identificador anônimo do visitante (sobrevive entre páginas do funil)
  var vid;
  try {
    vid = localStorage.getItem('bz_vid');
    if (!vid) { vid = uid(); localStorage.setItem('bz_vid', vid); }
  } catch (e) { vid = uid(); }

  var qs = new URLSearchParams(location.search);
  function stored(k) {
    try { return qs.get(k) || sessionStorage.getItem(k) || localStorage.getItem(k) || ''; } catch (e) { return qs.get(k) || ''; }
  }

  var base = {
    vid: vid,
    page: section,
    path: location.pathname,
    ref: document.referrer && document.referrer.indexOf(location.host) === -1 ? document.referrer : '',
    utm_source: stored('utm_source'),
    device: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'mobile' : 'desktop',
    orderId: qs.get('pedido') || '',
    step: section === 'checkout' ? (window.__checkoutStep || 1) : 0
  };

  function beat(view, stepView) {
    var body = Object.assign({}, base, { view: !!view, stepView: !!stepView });
    try {
      fetch('/api/track/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
  }

  beat(true);
  var timer = setInterval(function () { beat(false); }, HEARTBEAT_MS);

  // Volta à aba → avisa na hora em vez de esperar o próximo ciclo
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') beat(false);
  });

  // Saiu do site / fechou a aba → some do "ao vivo" imediatamente
  window.addEventListener('pagehide', function () {
    clearInterval(timer);
    try {
      var blob = new Blob([JSON.stringify({ vid: vid, page: section })], { type: 'text/plain' });
      navigator.sendBeacon && navigator.sendBeacon('/api/track/leave', blob);
    } catch (e) {}
  });

  window.bzTrack = {
    vid: vid,
    section: section,
    // Checkout em etapas: avisa o painel quando o cliente avança/volta
    setStep: function (n) {
      if (section !== 'checkout' || base.step === n) return;
      base.step = n;
      beat(false, true);
    }
  };
})();
