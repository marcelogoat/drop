// server.js — servidor local. Serve as páginas de public/ e usa o MESMO backend
// da Vercel (api/index.js), para que local e produção não fiquem diferentes.
const express = require('express');
const path    = require('path');
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
