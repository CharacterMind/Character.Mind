const http = require('http');
const server = http.createServer((req, res) => {
  res.end('Hello World');
});
server.listen(3001, () => {
  process.stdout.write('Test server on port 3001\n');
});
