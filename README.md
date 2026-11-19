# Bazari — Landing Page & Funil de Vendas PIX

Funil de alta conversão para e-commerce / dropshipping integrado com **Veno Payments (PIX)** e **Meta Pixel**.

## 🚀 Estrutura do Funil
- `index.html`: Landing Page completa da Lavadora de Alta Pressão Tramontina 1200W (Eventos: PageView, InitiateCheckout).
- `checkout.html`: Checkout de alta conversão focado em PIX com autocomplete de CEP, validação de campos e Order Bump (Garantia VIP 12M).
- `pagar.html`: Tela de pagamento PIX com QR Code dinâmico, código Copia e Cola, temporizador de 15 minutos e polling em tempo real.
- `obrigado.html`: Tela de confirmação e agradecimento com detalhes do pedido, timeline de expedição e disparo de evento **Purchase** (Meta Pixel).
- `rastreio.html`: Página de rastreamento com status de envio dos Correios / Transportadora.
- `server.js`: Backend Node.js / Express proxy seguro para a API da Veno Payments.

## 🛠️ Como Executar Localmente
```bash
# Instalar dependências
npm install

# Iniciar servidor
node server.js
# Ou dê duplo clique em iniciar-servidor.bat
```
Acesse: `http://localhost:3002/index.html`
