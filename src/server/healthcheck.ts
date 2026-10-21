// Container HEALTHCHECK: exit code 0 if the app answers /api/health within 4 s.
// node:http without keep-alive and no process.exit(): the process ends on its
// own once the socket is closed (process.exit right after fetch can abort
// with a libuv assertion on some platforms).
import http from 'node:http';

const port = Number(process.env.PORT) || 8080;
process.exitCode = 1;

const req = http.get({ host: '127.0.0.1', port, path: '/api/health', agent: false, timeout: 4000 }, (res) => {
  res.resume();
  res.on('end', () => {
    process.exitCode = res.statusCode === 200 ? 0 : 1;
  });
});
req.on('timeout', () => req.destroy());
req.on('error', () => {
  process.exitCode = 1;
});
