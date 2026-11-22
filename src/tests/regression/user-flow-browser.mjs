import assert from 'node:assert/strict';
import { installRuntimeHelpers, assertResourceErrors } from './browser-runtime.mjs';

// A separate, fresh browser user journey. Identity cookies and all mutations are
// fixtures; forms, rules, search, documents, controls and router run the real build.
export async function runUserFlow(browser, base, flow, tasks) {
  const context = await browser.newContext();
  await installRuntimeHelpers(context);
  const page = await context.newPage();
  const errors = [], warnings = [], dialogs = [], writes = [], resourceErrors = [];
  const user = { username: 'flow-user-fixture', email: 'regression-flow@leticia.invalid', roles: ['ROLE_USER'], accessToken: 'fixture-token' };
  const assigned = tasks.slice(0, 2).reverse();
  let shuffles = 0, persisted;
  page.on('pageerror', e => errors.push(`${page.url()} ${e.stack || e.message}`));
  page.on('console', message => {
    if (message.type() === 'warning') warnings.push(message.text());
    if (message.type() === 'error') {
      if (message.text().startsWith('Failed to load resource:')) resourceErrors.push(`${message.text()} ${JSON.stringify(message.location())}`);
      else errors.push(`${page.url()} ${message.text()} ${JSON.stringify(message.location())}`);
    }
  });
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await context.route('**/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/v1/tasks/shuffle') { shuffles++; return route.fulfill({ json: assigned }); }
    if (request.method() === 'GET') return route.continue();
    assert.equal(request.method(), 'POST');
    const body = request.postDataJSON(); writes.push({ path, body });
    if (path === '/v1/auth/login') {
      assert.equal(body.email, user.email);
      await context.addCookies(Object.entries({ jwt: user, userdata: {}, sessionflow: flow }).map(([name, value]) => ({
        name, value: encodeURIComponent(JSON.stringify(value)), url: base
      })));
      return route.fulfill({ status: 201, json: { message: 'User Logged In Successfully!', email: user.email } });
    }
    if (path.startsWith('/v1/userdata/')) persisted = body;
    return route.fulfill({ json: { message: 'User-flow fixture accepted', status: 'OK' } });
  });
  await context.addInitScript(() => {
    const active = new Map(), peaks = { timer: 0, buffer: 0 }, start = window.setInterval, stop = window.clearInterval;
    window.setInterval = (fn, ms, ...args) => {
      const id = start(fn, ms, ...args); active.set(id, ms);
      peaks.timer = Math.max(peaks.timer, [...active.values()].filter(value => value === 1000).length);
      peaks.buffer = Math.max(peaks.buffer, [...active.values()].filter(value => value === 15000).length);
      return id;
    };
    window.clearInterval = id => { active.delete(id); return stop(id); };
    window.flowUserIntervals = () => [...active.values()];
    window.flowUserPeaks = () => ({ ...peaks });
  });
  const state = () => page.evaluate(() => JSON.parse(JSON.stringify(window.flowTestRuntime.globals().$store.state)));
  const navigate = path => page.evaluate(path => window.flowTestRuntime.globals().$router.push(path), path);
  const expectPath = path => page.waitForURL(url => url.pathname === path);
  const postCount = path => writes.filter(w => w.path === path).length;
  const capture = name => process.env.FLOW_TEST_ARTIFACT_DIR
    ? page.screenshot({ path: `${process.env.FLOW_TEST_ARTIFACT_DIR}/${name}.png`, fullPage: true })
    : Promise.resolve();
  async function chooseSelect(id, text) {
    const input = page.locator(`#${id} input.vs__search`);
    await input.fill(text); await page.locator(`#${id} [role="option"]`).filter({ hasText: text }).first().click();
  }
  async function answerForm(form, count) {
    await page.waitForSelector(`${form} input[type=radio]`);
    const groups = await page.locator(`${form} input[type=radio]`).evaluateAll(inputs => [...new Set(inputs.map(input => input.name))]);
    assert.equal(groups.length, count);
    for (const name of groups) await page.locator(`${form} input[type=radio][name="${name}"][value="3"]`).check({ force: true });
    assert.equal(await page.locator(form).evaluate(el => el.checkValidity()), true);
    await page.locator(`${form} button[type=submit]`).click();
  }
  try {
    await page.goto(base + '/search'); await expectPath('/oauth');
    await page.getByRole('link', { name: 'Login with Email', exact: true }).click();
    await expectPath('/login');
    const email = page.locator('input#login-email');
    await email.fill('invalid-email'); await page.locator('#input-password').fill('fixture-password');
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    assert.equal(postCount('/v1/auth/login'), 0, 'Invalid native login form submitted');
    // The baseline's template VeeValidate directives are commented out. Attach a
    // test-only rule to the real Login field/validator; do not change app policy.
    const invalid = await page.evaluate(async () => {
      const login = window.flowTestRuntime.component('Login');
      login.$validator.attach({ name: 'regression-email', rules: 'required|email', getter: () => login.form.email });
      return { valid: await login.$validator.validate('regression-email', login.form.email), errors: login.$validator.errors.has('regression-email') };
    });
    assert.deepEqual(invalid, { valid: false, errors: true });
    await email.fill(user.email);
    assert.equal(await page.evaluate(async () => {
      const login = window.flowTestRuntime.component('Login');
      const valid = await login.$validator.validate('regression-email', login.form.email);
      login.$validator.detach('regression-email'); return valid;
    }), true);
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await expectPath('/user-hub'); assert.equal(postCount('/v1/auth/login'), 1);
    assert.equal((await state()).auth.user.username, user.username);
    assert.match(await page.locator('.progress').innerText(), /0%\s*completed/);
    console.log('OK User flow: auth guard, login/native validity, VeeValidate invalid/valid rules, translated progress');
    await page.locator('#leticia-content .btn-success').click(); await expectPath('/consent');
    await page.locator('button[type=submit]').click(); assert.equal(postCount('/v1/consent'), 0);
    await page.locator('[name="consent-name"]').fill('Regression Fixture');
    await page.locator('[name="consent-email"]').fill(user.email);
    await page.locator('#checkbox-accept').check({ force: true });
    await page.locator('button[type=submit]').click(); await expectPath('/demographic');
    assert.equal((await state()).hasAcceptedConsent, true);
    for (const id of ['sex', 'handedness', 'language', 'keyboard', 'searchengine', 'student', 'dyslexia', 'colorblindness']) {
      await page.locator(`#input-${id} input[type=radio]`).first().check({ force: true });
    }
    await page.locator('#input-age').fill('25'); await page.locator('#input-education').selectOption('Undergraduate');
    await chooseSelect('input-country', 'Chile');
    await page.locator('#input-region input.vs__search').click(); await page.locator('#input-region [role=option]').first().click();
    await page.locator('#input-city input.vs__search').click(); await page.locator('#input-city [role=option]').first().click();
    assert.equal(await page.locator('form').evaluate(el => el.checkValidity()), true);
    await capture('demographic');
    await page.locator('button[type=submit]').click(); await expectPath('/instructions');
    assert.equal(postCount('/v1/demographic'), 1);
    const demographic = writes.find(w => w.path === '/v1/demographic').body;
    assert.equal(demographic.answers.find(a => a.question === 'country').answer, 'Chile');
    await page.locator('#leticia-content .btn-success').click(); await expectPath('/ready');
    let current = await state(); const order = current.tasks.map(t => t.searchTaskId);
    assert.deepEqual(order, assigned.map(t => t.searchTaskId)); assert.equal(current.stageIndex, 0); assert.equal(current.flowIndex, 3);
    assert.equal(current.sessionFlow.sessionFlowId, flow.sessionFlowId); assert.equal(shuffles, 1);
    assert.deepEqual(persisted.state.stages, current.stages); assert.equal(persisted.state.stageIndex, 0);
    console.log('OK User flow: consent, demographic controls, instructions, initial assignment and persisted stage zero');
    await page.reload(); await expectPath('/ready');
    await navigate('/user-hub'); await page.locator('#leticia-content .btn-success').click(); await expectPath('/ready');
    current = await state(); assert.deepEqual(current.tasks.map(t => t.searchTaskId), order); assert.equal(shuffles, 1);
    assert.equal(await page.evaluate(() => {
      const root = window.flowTestRuntime.root();
      return root.axios === root.$http && root.axios === window.flowTestRuntime.globals().axios && root.axios.defaults.baseURL.endsWith('/v1/');
    }), true);
    const intervals = await page.evaluate(() => window.flowUserIntervals());
    assert.equal(intervals.filter(ms => ms === 1000).length, 1);
    for (let taskIndex = 0; taskIndex < 2; taskIndex++) {
      const taskId = order[taskIndex];
      await page.locator('#leticia-content .btn-success').click(); await expectPath('/description');
      assert.equal((await state()).currentTask.searchTaskId, taskId);
      await page.locator('#leticia-content .btn-success').click(); await expectPath('/taskform');
      assert.equal(new URL(page.url()).searchParams.get('form'), 'pretask');
      await answerForm('#taskform', 3); await expectPath('/search');
      await page.locator('#query-box').fill('javascript');
      await page.locator('#query-box').press('Enter'); await page.locator('.result-title').first().waitFor();
      assert.equal(new URL(page.url()).searchParams.get('q'), 'javascript');
      assert.equal(await page.locator('.result-title').count(), 5);
      // Open actual BootstrapVue modal and close it with its real OK control.
      await capture(`search-${taskIndex + 1}`);
      await page.getByRole('button', { name: 'Current task', exact: true }).click();
      await page.locator('#current-task').waitFor({ state: 'visible' });
      await page.waitForFunction(() => getComputedStyle(document.getElementById('current-task')).opacity === '1');
      assert((await page.locator('#current-task').innerText()).includes(assigned[taskIndex].title));
      await capture(`task-modal-${taskIndex + 1}`);
      await page.locator('#current-task').getByRole('button', { name: 'OK', exact: true }).click();
      await page.locator('#current-task').waitFor({ state: 'hidden' });
      for (let docIndex = 0; docIndex < 3; docIndex++) {
        const link = page.locator('.result-title').nth(docIndex), href = await link.getAttribute('href');
        const id = new URL(href, base).searchParams.get('id');
        await link.click(); await expectPath('/page'); await page.locator('#page-iframe').waitFor();
        await page.frameLocator('#page-iframe').locator('h1').waitFor();
        assert.equal((await state()).lastVisitedDoc.docId_s, id);
        if (docIndex === 0) await capture(`document-${taskIndex + 1}`);
        await page.getByRole('button', { name: 'Bookmark', exact: true }).click();
        assert.equal((await state()).bookmarkList.length, docIndex + 1);
        if (docIndex === 0) {
          await page.getByRole('button', { name: 'Unbookmark', exact: true }).click(); assert.equal((await state()).bookmarkList.length, 0);
          await page.getByRole('button', { name: 'Bookmark', exact: true }).click(); assert.equal((await state()).bookmarkList.length, 1);
        }
        let resumedToSearch = false;
        if (taskIndex === 0 && docIndex === 0) {
          const bookmarked = (await state()).bookmarkList;
          await page.reload(); await page.locator('#page-iframe').waitFor();
          assert.deepEqual((await state()).bookmarkList, bookmarked);
          assert.equal((await state()).lastVisitedDoc.docId_s, id);
          const remaining = (await state()).timerTime;
          await navigate('/user-hub'); await page.locator('#leticia-content .btn-success').click(); await expectPath('/search');
          assert.equal(shuffles, 1); assert.deepEqual((await state()).tasks.map(t => t.searchTaskId), order);
          assert.deepEqual((await state()).bookmarkList, bookmarked);
          assert((await state()).timerTime <= remaining && (await state()).timerTime > remaining - 5);
          assert.equal((await page.evaluate(() => window.flowUserIntervals())).filter(ms => ms === 1000).length, 1);
          await page.locator('#query-box').fill('javascript'); await page.locator('#query-box').press('Enter');
          await page.locator('.result-title').first().waitFor(); resumedToSearch = true;
          console.log('OK User flow: document reload/bookmark restore, timer resume and same task assignment');
        }
        if (docIndex < 2 && !resumedToSearch) {
          await page.getByRole('button', { name: 'Go Back', exact: true }).click(); await expectPath('/search');
          assert.equal(new URL(page.url()).searchParams.get('q'), 'javascript'); await page.locator('.result-title').first().waitFor();
        }
      }
      assert.equal((await state()).bookmarkList.length, 3);
      await page.getByRole('button', { name: 'Finish search', exact: true }).click(); await expectPath('/nasa-tlx');
      assert.equal((await state()).bookmarkList.length, 0); await answerForm('#nasa-tlx', 6); await expectPath('/taskform');
      assert.equal(new URL(page.url()).searchParams.get('form'), 'posttask');
      await answerForm('#taskform', 3); await expectPath(taskIndex === 0 ? '/ready' : '/end');
      current = await state(); assert.equal(current.tasks[taskIndex].completed, true);
      assert.equal(current.stageIndex, (taskIndex + 1) * 6);
      console.log(`OK User flow: ${taskId}, pretask/search/modal/documents/bookmark/unbookmark/NASA-TLX/posttask complete`);
    }
    await capture('end');
    current = await state(); assert.equal(current.flowIndex, 4); assert(current.tasks.every(t => t.completed));
    assert.equal(current.timerStatus, null); assert.equal(current.timerTime, null);
    assert.equal(await page.evaluate(() => window.flowTestRuntime.component('navbar').timer), null);
    assert.equal((await page.evaluate(() => window.flowUserIntervals())).filter(ms => ms === 1000 || ms === 15000).length, 0);
    assert.deepEqual(await page.evaluate(() => window.flowUserPeaks()), { timer: 1, buffer: 1 });
    assert.equal(shuffles, 1); assert.equal(persisted.state.flowIndex, 4); assert.equal(persisted.state.stageIndex, 12);
    const answers = writes.filter(w => w.path === '/v1/answers'); assert.equal(answers.length, 6);
    for (const task of assigned) for (const form of ['pretask', 'nasatlx', 'posttask']) {
      const answer = answers.find(w => w.body.taskId === task.searchTaskId && w.body.formId === form)?.body;
      assert(answer); assert.equal(answer.username, user.username);
      assert(answer.answers.every(a => a.answer === 3));
      if (form === 'nasatlx') assert.equal(answer.score, 10);
    }
    const actions = writes.filter(w => w.path === '/v1/actions').map(w => w.body);
    for (const type of ['PageEnter','PageExit','SearchQuery','SearchResultClick','ShowTaskModal','FinishSearchStage']) assert(actions.some(a => a.type === type), type);
    for (const action of actions) {
      assert.equal(action.username, user.username); assert.equal(typeof action.clientTimestamp, 'number'); assert(action.url.startsWith('/'));
      if (action.type === 'PageEnter' || action.type === 'PageExit') assert.equal(action.url, action.details.fullPath);
      if (action.type === 'SearchResultClick') { assert(action.url.startsWith('/search?')); assert.equal(typeof action.details.ranking, 'number'); }
    }
    for (const {body} of writes.filter(w => w.path === '/v1/bookmarks')) { assert(body.url.startsWith('/page?id=')); assert(order.includes(body.task)); }
    assertResourceErrors(resourceErrors);
    assert.equal(errors.length, 0, [...new Set(errors.map(e => e.split('\n')[0]))].join('; ')); assert.deepEqual(dialogs, []);
    console.log(`OK Full user flow: two tasks, six answer payloads, final state/timer cleanup, ${writes.length} intercepted POSTs, no server writes`);
    console.log('User-flow resource console messages:', JSON.stringify([...new Set(resourceErrors)]));
    console.log('User-flow warnings:', JSON.stringify([...new Set(warnings)]));
  } finally {
    if (errors.length) console.error('User-flow errors:', JSON.stringify([...new Set(errors)]));
    await context.close();
  }
}
