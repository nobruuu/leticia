import {
  assert, check, configuration, documentURL, failure, html, identifier, json, object, request
} from './helpers.mjs';

async function main() {
  assert(process.argv.length === 2, 'El smoke no acepta flags de escritura');
  const { base, timeout } = configuration();
  const get = path => request(new URL(path, base), { timeout });
  const flowId = identifier(process.env.REGRESSION_FLOW || 'flow1');
  const docId = identifier(process.env.REGRESSION_DOCUMENT || 'doc01');
  const query = process.env.REGRESSION_QUERY || 'javascript';

  console.log(`Smoke de sólo lectura: ${base.origin}; flow=${flowId}; documento=${docId}`);

  const index = await check('servidor y HTML de la SPA', async () => {
    const response = await get('/');
    html(response);
    assert(/id=["']app["']/.test(response.body), 'Falta el contenedor app');
    return response.body;
  });

  await check('scripts y estilos del frontend servidos', async () => {
    const refs = [];
    for (const match of index.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) refs.push(['script', match[1]]);
    for (const match of index.matchAll(/<link\b[^>]*>/gi)) {
      if (/\brel=["']stylesheet["']/i.test(match[0])) {
        const href = match[0].match(/\bhref=["']([^"']+)["']/i);
        assert(href, 'Stylesheet sin href');
        refs.push(['style', href[1]]);
      }
    }
    assert(refs.some(([type]) => type === 'script'), 'Falta script frontend');
    assert(refs.some(([type]) => type === 'style'), 'Falta stylesheet frontend');
    for (const [type, path] of refs) {
      const url = new URL(path, base);
      assert.equal(url.origin, base.origin, 'El smoke no solicita assets de otros orígenes');
      const response = await request(url, { timeout });
      assert.equal(response.status, 200, `Asset no disponible: ${url.pathname}`);
      const contentType = response.headers['content-type'] || '';
      assert(type === 'script' ? /(?:java|ecma)script/i.test(contentType) : /text\/css/i.test(contentType),
        `Asset con Content-Type incorrecto: ${url.pathname}`);
      assert(response.body.trim().length > 0, 'Asset vacío');
    }
  });

  await check('fallback de ruta SPA profunda', async () => {
    const response = await get('/search?task=task01');
    html(response);
    assert.equal(response.body, index, 'La ruta SPA no devuelve el mismo index');
  });

  await check('API JSON y definición del flow', async () => {
    const flow = json(await get(`/v1/flows/${flowId}`));
    object(flow, 'Flow ausente');
    assert.equal(flow.sessionFlowId, flowId, 'Flow inesperado');
    assert(Array.isArray(flow.stages) && flow.stages.length > 0, 'Flow sin stages');
    if (flowId === 'flow1') {
      assert.deepEqual(flow.stages.map(stage => stage.path),
        ['/consent', '/demographic', '/instructions', '/challenge', '/end'], 'Stages globales de flow1 cambiaron');
      const stages = flow.stages.find(stage => stage.path === '/challenge').stages;
      assert.deepEqual(stages.map(stage => [stage.path, stage.query?.form || null]), [
        ['/ready', null], ['/description', null], ['/taskform', 'pretask'],
        ['/search', null], ['/nasa-tlx', 'nasatlx'], ['/taskform', 'posttask']
      ], 'Subetapas de flow1 cambiaron');
    }
  });

  await check('tareas y resolución de preguntas sin solicitar asignación', async () => {
    for (const taskId of ['task01', 'task02']) {
      const task = json(await get(`/v1/tasks/${taskId}`));
      assert.equal(task?.searchTaskId, taskId, 'Tarea baseline ausente');
    }
    const questions = json(await get('/v1/forms/fetch/pretask'));
    assert(Array.isArray(questions) && questions.length > 0, 'Pretask sin preguntas resueltas');
    assert(questions.every(question => typeof question.questionId === 'string'), 'Preguntas inválidas');
  });

  const doc = await check('búsqueda Solr mediante API: documento, ranking y path', async () => {
    const response = json(await get(`/v1/search?q=${encodeURIComponent(query)}&p=1`));
    const result = response.result;
    object(result, 'Resultado de búsqueda ausente');
    assert(result.numFound > 0 && Array.isArray(result.docs), 'Búsqueda sin resultados');
    assert.equal(result.query, query, 'Query devuelta incorrecta');
    assert.equal(result.start, 0, 'Inicio de ranking incorrecto');
    assert(result.docs.length > 0 && result.docs.length <= 10, 'Tamaño de página inesperado');
    result.docs.forEach((value, i) => {
      assert.equal(value.ranking, i + 1, 'Ranking incorrecto');
      documentURL(base, value);
    });
    const expected = result.docs.find(value => value.docId_s === docId);
    assert(expected, 'Documento esperado no está en la primera página de la query baseline');
    return expected;
  });

  await check('HTML del documento local; no fallback SPA', async () => {
    const url = documentURL(base, doc);
    if (process.env.REGRESSION_DOCUMENT_PATH) {
      assert.equal(doc.path_s, process.env.REGRESSION_DOCUMENT_PATH, 'Path diferente del esperado');
    }
    const response = await request(url, { timeout });
    html(response);
    assert.notEqual(response.body, index, 'El documento devolvió index de la SPA');
  });
  console.log('Smoke completo. No se enviaron escrituras ni se solicitó /tasks/shuffle.');
}

main().catch(failure);
