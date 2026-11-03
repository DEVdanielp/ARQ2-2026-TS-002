/**
 * A tiny HTTP server for services without a Nest HTTP app (the GPS Tracking
 * Worker): `GET /metrics` for Prometheus and `GET /health` for humans and
 * probes. Nothing else is served, and Kong does not route to it.
 */
import { createServer, type Server } from 'node:http';
import { METRICS_PATH, serveMetrics } from './http.js';

export function startMetricsServer(port: number | string): Promise<Server> {
  const server = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0];
    if (path === METRICS_PATH) {
      serveMetrics(request, response);
    } else if (path === '/health') {
      response.setHeader('Content-Type', 'application/json');
      response.end('{"status":"UP"}');
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(port), () => resolve(server));
  });
}
