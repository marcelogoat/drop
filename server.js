// server.js — servidor local. Serve as páginas de public/ e usa o MESMO backend
// da Vercel (api/index.js), para que local e produção não fiquem diferentes.
const express = require('express');
const path    = require('path');

// Carrega variáveis do arquivo .env local (não versionado) ANTES de carregar o
// backend, porque api/index.js lê as chaves no momento do require. Na Vercel as
// variáveis já vêm do ambiente, então este passo é ignorado (não há .env lá).
(function carregarEnvLocal() {
  try {
    const fs = require('fs');
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const linha of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch (e) { /* segue sem .env */ }
})();

const api     = require('./api/index.js');

const app = express();
const PUBLIC = path.join(__dirname, 'public');

app.get(['/admin', '/admin/'], (req, res) => res.sendFile(path.join(PUBLIC, 'admin.html')));
app.use(express.static(PUBLIC));
app.use(api);

if (require.main === module) {
  const PORT = process.env.PORT || 3002;
  app.listen(PORT, () => {
    console.log(`\n🚀 Bazari em http://localhost:${PORT}`);
    console.log(`   Painel: http://localhost:${PORT}/admin\n`);
  });
}

module.exports = app;
