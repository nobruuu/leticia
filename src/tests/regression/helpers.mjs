import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';

export { assert };

export function configuration(env = process.env) {
  const base = new URL(env.REGRESSION_BASE_URL || 'http://localhost:3000');
  assert(['http:', 'https:'].includes(base.protocol), 'La URL debe ser HTTP(S)');
  assert(!base.username && !base.password && base.pathname === '/' && !base.search && !base.hash,
    'REGRESSION_BASE_URL debe ser un origen sin credenciales ni ruta');
  const timeout = Number(env.REGRESSION_TIMEOUT_MS || 5000);
  assert(Number.isInteger(timeout) && timeout > 0 && timeout <= 60000, 'Timeout inválido');
  return { base, timeout };
}

// No redirects, retries or cookie jar: each request is explicit and bounded.
export function request(url, { method = 'GET', body, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method,
      headers: {
        // Express history fallback checks Accept; Node's HTTP client does not set it.
        Accept: '*/*',
        ...(data === undefined ? {} : {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        })
      }
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 12 * 1024 * 1024) req.destroy(new Error('Respuesta mayor a 12 MiB'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('Respuesta interrumpida')));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    const timer = setTimeout(() => req.destroy(new Error('Timeout HTTP')), timeout);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(data);
  });
}

export function json(response, status = 200) {
  assert.equal(response.status, status, `HTTP esperado: ${status}; recibido: ${response.status}`);
  assert(/application\/json/i.test(response.headers['content-type'] || ''), 'Se esperaba JSON, no fallback HTML');
  return JSON.parse(response.body);
}

export function object(value, message) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), message);
}

export function identifier(value) {
  assert(/^[a-zA-Z0-9_-]+$/.test(value), 'Identificador inválido');
  return value;
}

export function documentURL(base, doc) {
  identifier(doc.docId_s);
  assert(typeof doc.path_s === 'string' && doc.path_s.startsWith(`/assets/documents/${doc.docId_s}/`),
    'El documento debe apuntar a su asset local');
  const url = new URL(doc.path_s, base);
  assert(url.origin === base.origin && url.pathname.startsWith(`/assets/documents/${doc.docId_s}/`),
    'Ruta documental fuera del origen/directorio esperado');
  return url;
}

export function html(response) {
  assert.equal(response.status, 200, 'El HTML debe responder HTTP 200');
  assert(/text\/html/i.test(response.headers['content-type'] || ''), 'Content-Type no es HTML');
  assert(/<(?:!doctype\s+html|html)\b/i.test(response.body), 'Documento HTML inválido');
}

export function cookieJSON(response, name) {
  const cookies = response.headers['set-cookie'] || [];
  const cookie = cookies.find(value => value.startsWith(`${name}=`));
  assert(cookie, `Falta cookie ${name}`);
  const value = decodeURIComponent(cookie.split(';', 1)[0].slice(name.length + 1));
  return JSON.parse(value.startsWith('j:') ? value.slice(2) : value);
}

export async function check(label, fn) {
  const result = await fn();
  console.log(`OK ${label}`);
  return result;
}

export function failure(error) {
  // Do not print response bodies, tokens, passwords or Mongo connection strings.
  let message = error.message || 'Error desconocido';
  for (const [name, value] of Object.entries(process.env)) {
    if (/PASSWORD|TOKEN|SECRET|KEY|MONGO.*URL/.test(name) && value) message = message.split(value).join('<omitido>');
  }
  message = message.replace(/mongodb(?:\+srv)?:\/\/\S+/g, '<Mongo URL omitida>');
  console.error(`FALLO ${message}`);
  process.exitCode = 1;
}
