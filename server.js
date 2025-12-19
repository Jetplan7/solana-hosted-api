
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'application/json'});
  res.end(JSON.stringify({ ok: true, version: "1.5.1-fix10" }));
});
server.listen(process.env.PORT || 10000);
