// Point d'entrée du serveur de salons (image Docker « relay »).
import { createServer } from 'node:http';
import { createRelay } from './relay.mjs';

const port = Number(process.env.PORT) || 8081;
const relay = createRelay();

const server = createServer((req, res) => {
  if (!relay.handle(req, res)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Introuvable\n');
  }
});
// les flux SSE restent ouverts : pas de délai d'inactivité côté Node
server.requestTimeout = 0;
server.headersTimeout = 30_000;
server.keepAliveTimeout = 65_000;

server.listen(port, () => console.log(`relais de salons sur le port ${port}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    relay.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
