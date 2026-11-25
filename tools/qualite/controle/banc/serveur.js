// Banc d'essai du contrôle et de la maintenance : remplace l'API ou le site de Cahiora. Répond 200 à toute adresse ;
// /api/v1/lent répond après 6 secondes (requête déjà partie quand la fenêtre de maintenance s'ouvre).
const http = require('http');
const port = Number(process.env.PORT_ESSAI || 4000);
http
  .createServer((req, res) => {
    const fin = () => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`ok ${process.env.ROLE_ESSAI} ${req.url}`);
    };
    if (req.url.startsWith('/api/v1/lent')) setTimeout(fin, 6000);
    else fin();
  })
  .listen(port);
