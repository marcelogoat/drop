/* guard.js — bloqueio de zoom no mobile e dissuasor de inspeção.
   Observação: bloquear o inspetor é apenas um DISSUASOR; não é proteção real,
   pois o conteúdo do site é sempre entregue ao navegador. Serve para dificultar
   a cópia casual. Não é incluído no painel /admin. */
(function () {
  'use strict';

  // ── Dissuasor de inspeção ──────────────────────────────────────────────
  // Clique direito / menu de contexto
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); }, { capture: true });

  // Atalhos de teclado: F12, Ctrl/Cmd+Shift+I/J/C, Ctrl/Cmd+U (ver código), Ctrl/Cmd+S (salvar)
  document.addEventListener('keydown', function (e) {
    var k = (e.key || '').toLowerCase();
    if (e.key === 'F12') { e.preventDefault(); return false; }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (k === 'i' || k === 'j' || k === 'c')) { e.preventDefault(); return false; }
    if ((e.ctrlKey || e.metaKey) && (k === 'u' || k === 's')) { e.preventDefault(); return false; }
  }, { capture: true });

  // ── Bloqueio de zoom no mobile ─────────────────────────────────────────
  try { document.documentElement.style.touchAction = 'manipulation'; } catch (e) {}

  // Zoom por gesto de pinça (iOS Safari)
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (ev) {
    document.addEventListener(ev, function (e) { e.preventDefault(); }, { passive: false });
  });

  // Zoom por Ctrl + scroll (desktop)
  document.addEventListener('wheel', function (e) { if (e.ctrlKey) e.preventDefault(); }, { passive: false });

  // Zoom por pinça (dois dedos) no Android/Chrome
  document.addEventListener('touchmove', function (e) {
    if (e.touches && e.touches.length > 1) e.preventDefault();
  }, { passive: false });
})();
