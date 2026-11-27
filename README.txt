EA Bot gateway (Binance Spot)

1. Install Node 18 or newer on your server.
2. Put server.js and index.html in one folder.
3. Set environment variables, then run:
   export BINANCE_KEY="your key"
   export BINANCE_SECRET="your secret"
   export GATEWAY_TOKEN="a long random password (16+ characters)"
   export TZ="Asia/Amman"
   node server.js
   (Practice mode by default. Real money only when you also set LIVE=true.)
4. Serve it over HTTPS, for example with Caddy:
   caddy reverse-proxy --from yourdomain.com --to localhost:3000
5. Open https://yourdomain.com on your phone and sign in with GATEWAY_TOKEN.
