import { randomUUID } from 'node:crypto';
import { assert, check, configuration, cookieJSON, failure, json, object, request } from './helpers.mjs';

const KIND = 'leticia-baseline-regression';

async function main() {
  const flags = process.argv.slice(2);
  assert(flags.every(flag => ['--write', '--create-account'].includes(flag)), 'Flag desconocido');
  const write = flags.includes('--write');
  const create = flags.includes('--create-account');
  assert(!create || write, '--create-account requiere --write');
  assert(!write || process.env.REGRESSION_ALLOW_WRITES === '1',
    'Escrituras deshabilitadas: requiere REGRESSION_ALLOW_WRITES=1 y --write');
  const email = process.env.REGRESSION_EMAIL || 'regression-baseline@leticia.invalid';
  assert(/^regression-[a-z0-9][a-z0-9._+-]*@leticia\.invalid$/.test(email),
    'Cuenta reservada requerida: regression-...@leticia.invalid');
  const password = process.env.REGRESSION_PASSWORD;
  assert(!write || (password && password.length >= 12), 'Se requiere REGRESSION_PASSWORD de al menos 12 caracteres');
  const dataUrl = process.env.REGRESSION_MONGO_DATA_URL;
  const userUrl = process.env.REGRESSION_MONGO_USER_URL;
  assert(dataUrl && userUrl && dataUrl !== userUrl, 'Especifica dos REGRESSION_MONGO_{DATA,USER}_URL diferentes');
  const { base, timeout } = configuration();
  const flowId = process.env.REGRESSION_FLOW || 'flow1';
  const api = async (path, body, status = 200) => json(await request(new URL(`/v1${path}`, base), {
    method: body === undefined ? 'GET' : 'POST', body, timeout
  }), status);
  const runId = `regression-${randomUUID()}`;
  console.log(`${write ? 'ESCRITURA OPT-IN' : 'Sólo lectura'}: ${email}; runId=${runId}`);
  if (write) console.log('Pueden quedar cuenta, snapshot, Answer y Action aunque una comprobación posterior falle. No hay reintentos ni borrado.');

  // Existing dependency only. Do not import server models/db: those initialize application connections/indexes.
  const { default: mongoose } = await import('mongoose');
  const connections = [];
  try {
    for (const url of [dataUrl, userUrl]) {
      const connection = mongoose.createConnection(url, {
        useNewUrlParser: true, useUnifiedTopology: true, autoIndex: false,
        serverSelectionTimeoutMS: timeout
      });
      connections.push(connection);
      // Mongoose 5 connection is thenable; this does not migrate Mongoose.
      await connection;
    }
    const [data, users] = connections;
    assert(!(data.db.databaseName === users.db.databaseName && data.host === users.host && data.port === users.port),
      'Las dos conexiones no pueden apuntar a la misma base');
    const credentials = users.db.collection('credentials');
    let credential = await credentials.findOne({ email });
    if (!credential) {
      assert(create, 'Cuenta inexistente. Crear una sola vez con --write --create-account');
      const registration = await request(new URL('/v1/auth/register', base), {
        method: 'POST', body: { email, password }, timeout
      });
      assert.equal(json(registration, 201).email, email, 'Respuesta de registro incorrecta');
      const identity = cookieJSON(registration, 'jwt');
      assert.equal(identity.email, email, 'Cookie de registro incorrecta');
      assert.equal(cookieJSON(registration, 'sessionflow')?.sessionFlowId, flowId, 'Flow de registro incorrecto');
      object(cookieJSON(registration, 'userdata'), 'Cookie inicial userdata inválida');
      credential = await credentials.findOne({ email });
      assert(credential?.username === identity.username, 'API y Mongo no apuntan a la misma identidad');
      console.log('OK cuenta reservada creada (username pseudónimo generado por LETICIA)');
    }
    assert.equal(await credentials.countDocuments({ email }), 1, 'Email de prueba duplicado');
    const username = credential.username;
    assert(typeof username === 'string' && username.length > 0, 'Credential sin username');
    assert.equal(await credentials.countDocuments({ username }), 1, 'Username compartido por otras credenciales: no se escribirá');
    assert(typeof credential.password === 'string' && credential.password !== password, 'Credential sin hash de password');
    const owned = { username };

    const snapshot = await check('User / Credential / UserData relacionados por username', async () => {
      assert.equal(await data.db.collection('users').countDocuments(owned), 1, 'User ausente o duplicado');
      assert.equal(await data.db.collection('userdata').countDocuments(owned), 1, 'UserData ausente o duplicado');
      const stored = await data.db.collection('userdata').findOne(owned);
      const viaApi = await api(`/userdata/${encodeURIComponent(username)}`);
      assert.equal(viaApi?.username, username, 'UserData API/Mongo no coincide');
      assert.deepEqual(viaApi.state, stored.state, 'Snapshot API/Mongo no coincide');
      return stored;
    });
    if (!write) {
      console.log('Lectura completa. No se enviaron POST ni se escribieron datos.');
      return;
    }

    // Refuse to overwrite any state/activities outside this dedicated fixture.
    const state = snapshot.state || {};
    object(state, 'Estado de prueba inválido');
    assert(Object.keys(state).length === 0 || (Object.keys(state).length === 1 &&
      state.regression?.kind === KIND && state.regression?.email === email),
    'La cuenta tiene estado experimental: no se sobrescribirá');
    for (const name of ['taskrequests', 'demographics', 'bookmarks', 'keystrokes', 'mouseactions', 'scrollactions', 'userlogs', 'browserevents']) {
      assert.equal(await data.db.collection(name).countDocuments(owned), 0, 'La cuenta tiene actividad de participante: no se escribirá');
    }
    assert.equal(await users.db.collection('consents').countDocuments(owned), 0, 'La cuenta tiene consentimiento: no se escribirá');
    for (const name of ['answers', 'actions']) {
      assert.equal(await data.db.collection(name).countDocuments({ ...owned, 'regression.kind': { $ne: KIND } }), 0,
        'La cuenta tiene registros ajenos al test: no se escribirá');
    }

    const marker = { kind: KIND, email, runId };
    const savedState = { regression: marker };
    await check('POST snapshot → API y Mongo', async () => {
      // GET above establishes this exact username exists on both API and configured Mongo.
      await api(`/userdata/${encodeURIComponent(username)}`, { username, state: savedState, sessionFlow: snapshot.sessionFlow || {} });
      assert.deepEqual((await api(`/userdata/${encodeURIComponent(username)}`)).state, savedState, 'Snapshot no recuperable por API');
      assert.deepEqual((await data.db.collection('userdata').findOne(owned)).state, savedState, 'Snapshot no persistido en Mongo');
    });

    await check('login, cookies y rechazo de password incorrecta', async () => {
      const login = await request(new URL('/v1/auth/login', base), { method: 'POST', body: { email, password }, timeout });
      assert.equal(json(login, 201).email, email, 'Respuesta de login incorrecta');
      const identity = cookieJSON(login, 'jwt');
      assert.equal(identity.username, username, 'Login devuelve otro username');
      assert.equal(identity.email, email, 'Email del login incorrecto');
      assert(Array.isArray(identity.roles) && identity.roles.includes('ROLE_USER'), 'Roles de login ausentes');
      assert(typeof identity.accessToken === 'string' && identity.accessToken.split('.').length === 3, 'JWT ausente o mal formado');
      const payload = JSON.parse(Buffer.from(identity.accessToken.split('.')[1], 'base64url').toString('utf8'));
      assert.equal(payload.data?.username, username, 'JWT no corresponde al username del login');
      assert.equal(payload.data?.email, email, 'JWT no corresponde al email del login');
      assert.equal(cookieJSON(login, 'sessionflow')?.sessionFlowId, flowId, 'Flow del login incorrecto');
      assert.deepEqual(cookieJSON(login, 'userdata'), savedState, 'Cookie userdata no restaura snapshot');
      const rejected = await request(new URL('/v1/auth/login', base), {
        method: 'POST', body: { email, password: `${password}-incorrecta` }, timeout
      });
      assert.equal(json(rejected, 401).accessToken, null, 'Password incorrecta no rechazada');
      assert(!(rejected.headers['set-cookie'] || []).some(value => value.startsWith('jwt=')), 'Login rechazado entregó cookie jwt');
    });

    await check('POST Answer → persistencia identificada', async () => {
      const answer = {
        username, formId: 'regression-form', taskId: 'regression-task', clientTimestamp: Date.now(),
        answers: [{ questionId: 'regression-question', answer: runId }], regression: marker
      };
      await api('/answers', answer);
      const filter = { username, 'regression.runId': runId };
      assert.equal(await data.db.collection('answers').countDocuments(filter), 1, 'Answer no persistido una sola vez');
      const stored = await data.db.collection('answers').findOne(filter);
      for (const key of ['username', 'formId', 'taskId', 'answers', 'clientTimestamp', 'regression']) {
        assert.deepEqual(stored[key], answer[key], `Answer: campo ${key} incorrecto`);
      }
      assert(Number.isInteger(stored.serverTimestamp), 'Answer sin serverTimestamp');
    });

    await check('POST Action → username / type / details / URL en Mongo', async () => {
      const action = {
        username, type: 'RegressionSmoke', source: 'Regression', url: `/regression?run=${runId}`,
        clientTimestamp: Date.now(), details: { runId, test: true }, regression: marker
      };
      await api('/actions', action);
      const filter = { username, 'regression.runId': runId };
      assert.equal(await data.db.collection('actions').countDocuments(filter), 1, 'Action no persistida una sola vez');
      const stored = await data.db.collection('actions').findOne(filter);
      for (const key of ['username', 'type', 'source', 'url', 'details', 'clientTimestamp', 'regression']) {
        assert.deepEqual(stored[key], action[key], `Action: campo ${key} incorrecto`);
      }
      assert(Number.isInteger(stored.serverTimestamp), 'Action sin serverTimestamp');
    });
    console.log(`Persistencia completa: username=${username}; runId=${runId}. Snapshot reemplazado; 1 Answer y 1 Action añadidos. Sin limpieza.`);
  } finally {
    await Promise.all(connections.map(connection => connection.close()));
  }
}

main().catch(failure);
