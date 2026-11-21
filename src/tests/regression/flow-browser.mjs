// Optional browser companion. Playwright comes from an external validation image,
// never from the application dependency tree. All experimental writes are mocked.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.FLOW_TEST_PLAYWRIGHT_MODULE || '/workspace/node_modules/playwright/index.mjs');
const base = process.env.FLOW_TEST_BASE_URL || 'http://localhost:3000';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext();
const page = await context.newPage();
const devtools = await context.newCDPSession(page);
const executionContexts = new Map();
devtools.on('Runtime.executionContextCreated', ({ context }) => executionContexts.set(context.id, context));
devtools.on('Runtime.executionContextDestroyed', ({ executionContextId }) => executionContexts.delete(executionContextId));
devtools.on('Runtime.executionContextsCleared', () => executionContexts.clear());
await devtools.send('Runtime.enable');
const errors = [], dialogs = [], writes = [];
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
const flow = await context.request.get(`${base}/v1/flows/flow1`).then(r => r.json());
const tasks = await context.request.get(`${base}/v1/tasks`).then(r => r.json());
assert(Array.isArray(tasks) && tasks.length >= 2);
const assigned = tasks.slice(0, 2).reverse();
let shuffles = 0, releaseSnapshot;
let pendingSnapshot = new Promise(resolve => { releaseSnapshot = resolve; });
let latestSnapshot;
await context.route('**/v1/**', async route => {
  const request = route.request(), path = new URL(request.url()).pathname;
  if (path === '/v1/tasks/shuffle') {
    shuffles++;
    return route.fulfill({ json: assigned });
  }
  if (request.method() !== 'GET') {
    assert.equal(request.method(), 'POST', 'Unexpected mutation method');
    const body = request.postDataJSON();
    writes.push({ path, body });
    if (path.startsWith('/v1/userdata/')) {
      await pendingSnapshot;
      latestSnapshot = body;
    }
    return route.fulfill({ json: { message: 'Flow regression controlled IO', status: 'OK' } });
  }
  return route.continue();
});
await context.addInitScript(({ flow }) => {
  if (!localStorage.getItem('flow-regression-seeded')) {
    const user = { username: 'flow-browser-fixture', roles: ['ROLE_USER'] };
    localStorage.setItem('leticia-user', JSON.stringify(user));
    localStorage.setItem('leticia-vuex', JSON.stringify({
      auth: { user, status: { loggedIn: true } }, sessionFlow: flow,
      stageIndex: null, flowIndex: flow.stages.findIndex(s => s.path === '/challenge'),
      tasks: [], stages: [], bookmarkList: [], currentRoute: {},
      timerTime: 600, timerDuration: 600000, timerStatus: 'paused'
    }));
    localStorage.setItem('flow-regression-seeded', '1');
  }
  const intervals = new Map(), handlers = new Map();
  const originalSet = window.setInterval, originalClear = window.clearInterval;
  window.setInterval = function(fn, ms, ...args) {
    const id = originalSet(fn, ms, ...args); intervals.set(id, ms); return id;
  };
  window.clearInterval = function(id) { intervals.delete(id); return originalClear(id); };
  const add = window.addEventListener, remove = window.removeEventListener;
  window.addEventListener = function(type, fn, ...args) {
    if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn);
    return add.call(this, type, fn, ...args);
  };
  window.removeEventListener = function(type, fn, ...args) {
    handlers.get(type)?.delete(fn); return remove.call(this, type, fn, ...args);
  };
  window.flowTestCounts = () => ({ buffers: [...intervals.values()].filter(ms => ms === 15000).length,
    trackers: ['mousemove', 'click', 'scroll'].map(type => handlers.get(type)?.size || 0) });
}, { flow });
async function navigate(path) {
  await page.evaluate(async path => { await document.getElementById('leticia-app').__vue__.$router.push(path); }, path);
}
async function state() { return page.evaluate(() => JSON.parse(JSON.stringify(document.getElementById('leticia-app').__vue__.$store.state))); }
async function settled() { await page.waitForTimeout(150); }
const trackerTypes = ['mousemove', 'click', 'scroll'];
async function iframeTrackers(objectId) {
  const { listeners } = await devtools.send('DOMDebugger.getEventListeners', { objectId });
  return trackerTypes.map(type => listeners.filter(listener => listener.type === type).length);
}

try {
  await page.goto(`${base}/challenge`);
  await page.waitForFunction(() => document.getElementById('leticia-app')?.__vue__?.$store.state.stageIndex === 0);
  assert.equal(new URL(page.url()).pathname, '/challenge', 'Navigation preceded initial snapshot');
  assert.equal(writes.filter(w => w.path.startsWith('/v1/userdata/')).length, 1);
  releaseSnapshot(); pendingSnapshot = Promise.resolve();
  await page.waitForURL('**/ready?task=*');
  assert.equal(shuffles, 1);
  const initial = await state(), order = initial.tasks.map(t => t.searchTaskId);
  assert.deepEqual(order, assigned.map(t => t.searchTaskId));
  assert.equal(latestSnapshot.state.stageIndex, 0);
  console.log('OK Browser: assignment snapshot precedes navigation; actual Vue 2 mounted');

  await page.reload(); await page.waitForURL('**/ready?task=*');
  for (let i = 0; i < 3; i++) {
    await navigate('/user-hub');
    await page.locator('#leticia-content .btn-success').click();
    await page.waitForURL('**/ready?task=*');
  }
  assert.equal(shuffles, 1); assert.deepEqual((await state()).tasks.map(t => t.searchTaskId), order);
  await page.locator('#leticia-content .btn-success').click();
  await page.waitForURL('**/description?task=*'); await settled();
  assert.equal((await state()).stageIndex, 1);
  assert.equal(latestSnapshot.state.stageIndex, 1);
  console.log('OK Browser: reload/reentry keeps task order and index 0; one click advances once');

  const timer = await page.evaluate(() => {
    const a = document.getElementById('leticia-app').__vue__;
    const nav = a.$children.find(c => c.$options.name === 'navbar');
    window.flowTestTimer = nav.timer;
    return a.$store.state.timerTime;
  });
  const task = order[0];
  const search = `/search?task=${encodeURIComponent(task)}&q=javascript&p=1`;
  await navigate(search); await page.locator('.result-title').first().waitFor();
  const counts = await page.evaluate(() => window.flowTestCounts());
  assert.equal(counts.buffers, 1);
  const iframeRealms = new Set();
  for (let i = 0; i < 3; i++) {
    const before = writes.length;
    const href = await page.locator('.result-title').first().getAttribute('href');
    const docId = new URL(href, base).searchParams.get('id');
    await page.locator('.result-title').first().click(); await page.waitForURL('**/page?id=*');
    await page.locator('#page-iframe').waitFor();
    await page.frame({ name: 'page-iframe' }).waitForLoadState('load');
    await settled();
    // Resolve window in the iframe's own realm. Inspecting the parent's
    // contentWindow WindowProxy does not reveal these native listeners.
    const { frameTree } = await devtools.send('Page.getFrameTree');
    const iframe = frameTree.childFrames.find(child => child.frame.name === 'page-iframe');
    const realm = [...executionContexts.values()].find(c =>
      c.auxData?.frameId === iframe?.frame.id && c.auxData?.isDefault);
    assert(realm, 'Missing iframe execution context');
    iframeRealms.add(realm.id);
    assert.equal([...iframeRealms].filter(id => executionContexts.has(id)).length, 1, 'Previous iframe realm survived');
    const { result, exceptionDetails } = await devtools.send('Runtime.evaluate', {
      expression: 'window', contextId: realm.id, objectGroup: 'flow-test-iframe-trackers'
    });
    assert.equal(exceptionDetails, undefined);
    assert.deepEqual(await iframeTrackers(result.objectId), [1, 1, 1], `Iframe trackers in cycle ${i + 1}`);
    if (i === 0) {
      // Positive control: this measurement must detect an extra real listener.
      await page.evaluate(() => {
        window.flowTestIframeProbe = () => {};
        document.getElementById('page-iframe').contentWindow.addEventListener('click', window.flowTestIframeProbe);
      });
      assert.deepEqual(await iframeTrackers(result.objectId), [1, 2, 1], 'Iframe duplicate-listener control');
      await page.evaluate(() => {
        document.getElementById('page-iframe').contentWindow.removeEventListener('click', window.flowTestIframeProbe);
        delete window.flowTestIframeProbe;
      });
      assert.deepEqual(await iframeTrackers(result.objectId), [1, 1, 1]);
    }
    const current = await state(); assert.equal(current.lastVisitedDoc.docId_s, docId);
    const iframeSrc = await page.locator('#page-iframe').getAttribute('src');
    assert(iframeSrc.endsWith(current.lastVisitedDoc.path_s));
    assert.equal(await page.evaluate(() => Object.keys(document.getElementById('leticia-app').__vue__.$router.currentRoute.params).length), 0);
    const enter = writes.slice(before).filter(w => w.body.type === 'PageEnter');
    assert.equal(enter.length, 1); assert.equal(enter[0].body.url, new URL(page.url()).pathname + new URL(page.url()).search);
    const click = writes.slice(before).filter(w => w.body.type === 'SearchResultClick');
    assert.equal(click.length, 1); assert(click[0].body.url.includes('/search?'));
    const exits = writes.slice(before).filter(w => w.body.type === 'PageExit');
    assert.equal(exits.length, 1); assert.equal(exits[0].body.url, search);
    await page.goBack(); await page.locator('.result-title').first().waitFor(); await settled();
    assert.deepEqual(await page.evaluate(() => window.flowTestCounts()), counts);
    // Removing the iframe destroys its realm, so the old native target can no
    // longer be inspected. Assert actual context disposal instead of claiming
    // a listener count on a dead Window or on its parent-side WindowProxy.
    assert.equal([...iframeRealms].filter(id => executionContexts.has(id)).length, 0, `Live iframe realms after cycle ${i + 1}`);
    const afterBack = await devtools.send('Page.getFrameTree');
    assert.equal(afterBack.frameTree.childFrames?.length || 0, 0);
    console.log(`OK Browser: iframe cycle ${i + 1}: native mousemove/click/scroll = 1/1/1; after back no live iframe realm`);
  }
  const afterTimer = await page.evaluate(() => {
    const a = document.getElementById('leticia-app').__vue__, nav = a.$children.find(c => c.$options.name === 'navbar');
    return { same: nav.timer === window.flowTestTimer, remaining: a.$store.state.timerTime };
  });
  assert(afterTimer.same); assert(afterTimer.remaining <= timer && afterTimer.remaining > timer - 30);
  console.log('OK Browser: three Search/document/back cycles; correct id/URL; one click/enter/exit; stable trackers and timer');

  await page.locator('.result-title').first().click(); await page.waitForURL('**/page?id=*');
  const selected = (await state()).lastVisitedDoc;
  await page.reload(); await page.locator('#page-iframe').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('id'), selected.docId_s);
  assert((await page.locator('#page-iframe').getAttribute('src')).endsWith(selected.path_s));
  console.log('OK Browser: document reload restores the matching persisted selection');

  await navigate('/page?id=regression-mismatch');
  assert.equal(await page.locator('#page-iframe').count(), 0);
  assert.equal(await page.evaluate(() => window.flowTestCounts().buffers), 0);
  assert.equal((await state()).lastVisitedDoc.docId_s === 'regression-mismatch', false);
  await page.reload(); await settled(); assert.equal(await page.locator('#page-iframe').count(), 0);
  console.log('OK Browser: mismatch/reload fails visibly without displaying another document');
  // Compare both real Search templates with the previous BLink/Router 3 policy.
  // An ancestor records defaultPrevented, then cancels the browser default solely
  // to keep modifier-click checks from opening new pages during the test.
  const clickPolicies = await page.evaluate(async () => {
    const app = document.getElementById('leticia-app').__vue__;
    const Vue = app.$options._base, Router = app.$router.constructor;
    const cases = [
      { name: 'normal', type: 'click', button: 0 },
      { name: 'Ctrl', type: 'click', button: 0, ctrlKey: true },
      { name: 'Cmd', type: 'click', button: 0, metaKey: true },
      { name: 'Shift', type: 'click', button: 0, shiftKey: true },
      { name: 'middle', type: 'auxclick', button: 1 }
    ];
    const results = [];
    for (const path of ['/search', '/extended-challenge/search']) {
      const config = path === '/search'
        ? app.$router.options.routes.find(r => r.path === path)
        : app.$router.options.routes.find(r => r.path === '/extended-challenge').children.find(r => r.path === 'search');
      const options = config.component.options || config.component;
      for (const variant of ['previous', 'current']) {
        for (const click of cases) {
          const router = new Router({ mode: 'abstract', routes: [
            { path: '/source' }, { name: 'page', path: '/page' }
          ] });
          await router.push('/source');
          let logs = 0, prevented;
          const doc = app.$store.state.lastVisitedDoc;
          const container = document.createElement('div');
          for (const type of ['click', 'auxclick']) container.addEventListener(type, event => {
            prevented = event.defaultPrevented;
            event.preventDefault();
          });
          document.body.appendChild(container);
          const vm = variant === 'previous' ? new Vue({ router, render: h => h('b-link', {
            props: { to: { name: 'page', query: { id: doc.docId_s } } },
            on: { click: () => logs++, auxclick: event => { event.preventDefault(); event.stopPropagation(); prevented = true; } }
          }, 'previous link') }) : new Vue({ ...options, router, store: app.$store, i18n: app.$i18n });
          vm.$mount(); container.appendChild(vm.$el);
          if (variant === 'current') {
            vm.sender = { sendGenericAction: async () => { logs++; return { data: {} }; } };
            vm.searchResults = [doc]; vm.serpStatus = 'results'; vm.displayFullSearch = false;
          }
          await Vue.nextTick();
          const link = variant === 'previous' ? vm.$el : vm.$el.querySelector('.result-title');
          const event = new MouseEvent(click.type, { ...click, bubbles: true, cancelable: true });
          link.dispatchEvent(event);
          results.push({ path, variant, click: click.name,
            spa: router.currentRoute.path === '/page', prevented: prevented ?? event.defaultPrevented, logs });
          vm.$destroy(); container.remove();
        }
      }
    }
    return results;
  });
  for (const current of clickPolicies.filter(r => r.variant === 'current')) {
    const previous = clickPolicies.find(r => r.variant === 'previous' && r.path === current.path && r.click === current.click);
    const policy = ({ spa, prevented, logs }) => ({ spa, prevented, logs });
    assert.deepEqual(policy(current), policy(previous), `${current.path}: ${current.click} changed navigation policy`);
    assert.deepEqual(policy(current), current.click === 'normal'
      ? { spa: true, prevented: true, logs: 1 }
      : current.click === 'middle' ? { spa: false, prevented: true, logs: 0 }
      : { spa: false, prevented: false, logs: 1 });
  }
  console.log('OK Browser: both Search templates preserve normal/Ctrl/Cmd/Shift/middle click policy against previous BLink/Router 3');

  assert.deepEqual(errors, []); assert.deepEqual(dialogs, []);
  console.log(`Flow browser checks passed. ${writes.length} intercepted POSTs; zero server writes; shuffle mocked (${shuffles}).`);
} finally { await context.close(); await browser.close(); }
