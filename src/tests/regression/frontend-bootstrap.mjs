// Real build smoke in Chromium. Playwright is supplied by the validation image.
// Only browser-local persistence is changed; experimental API writes are blocked.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.FLOW_TEST_PLAYWRIGHT_MODULE || '/workspace/node_modules/playwright/index.mjs');
const base = process.env.FLOW_TEST_BASE_URL || 'http://localhost:3000';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext();
const page = await context.newPage();
const errors = [], warnings = [];
let blockedWrites = 0;
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {
  if (message.type() === 'warning') warnings.push(message.text());
  if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) errors.push(message.text());
});
await context.route('**/v1/**', route => {
  if (route.request().method() === 'GET') return route.continue();
  blockedWrites++;
  return route.fulfill({ json: { message: 'Bootstrap test blocked experimental write' } });
});
await context.addInitScript(() => {
  if (!localStorage.getItem('bootstrap-regression-seeded')) {
    localStorage.setItem('leticia-vuex', JSON.stringify({ stageIndex: 0, hasAcceptedConsent: true }));
    localStorage.setItem('bootstrap-regression-seeded', '1');
  }
});
async function snapshot() {
  return page.evaluate(() => {
    const app = document.getElementById('app').__vue_app__;
    const root = app._container._vnode.component.proxy;
    const expectedAxios = app.config.globalProperties.axios;
    return {
      vue: app.version, mounted: root.$el.isConnected,
      path: root.$router.currentRoute.value.path,
      name: root.$router.currentRoute.value.name,
      stageIndex: root.$store.state.stageIndex,
      accepted: root.$store.state.hasAcceptedConsent,
      title: root.$t('home.title'),
      cookies: typeof root.$cookies.get,
      validator: typeof root.$validator.validate,
      axios: {
        getters: ['axios', '$http'].map(key => typeof Object.getOwnPropertyDescriptor(app.config.globalProperties, key)?.get),
        rootMatches: root.axios === expectedAxios && root.$http === expectedAxios,
        callable: typeof expectedAxios === 'function' && typeof expectedAxios.get === 'function',
        baseURL: expectedAxios?.defaults?.baseURL
      },
      components: Object.keys(app._context.components)
    };
  });
}
async function navigate(path) {
  await page.evaluate(path => {
    const app = document.getElementById('app').__vue_app__;
    return app.config.globalProperties.$router.push(path);
  }, path);
}
try {
  await page.goto(base + '/');
  await page.waitForSelector('#app #leticia-app');
  let current = await snapshot();
  assert.equal(current.vue, '3.5.45'); assert.equal(current.mounted, true);
  assert.equal(current.path, '/'); assert.equal(current.stageIndex, 0); assert.equal(current.accepted, true);
  assert(current.title && current.title !== 'home.title');
  assert((await page.locator('#leticia-app').innerText()).includes(current.title));
  assert.equal(await page.locator('nav.navbar').count(), 1);
  assert.equal(current.cookies, 'function'); assert.equal(current.validator, 'function');
  assert.deepEqual(current.axios, {
    getters: ['function', 'function'], rootMatches: true, callable: true,
    baseURL: new URL('/v1/', base).href
  });
  assert(current.components.includes('font-awesome-icon') && current.components.includes('v-select'));
  console.log('OK Vue 3 root, BootstrapVue navbar, Vuex restore, i18n and retained plugins');
  await navigate('/oauth'); assert.equal((await snapshot()).path, '/oauth');
  await navigate('/login'); await page.waitForSelector('#input-password');
  assert.equal((await snapshot()).path, '/login');
  console.log('OK Router navigates /, /oauth and /login; login inputs mounted');
  await navigate('/bootstrap-regression-missing');
  assert.equal((await snapshot()).name, 'not-found');
  await navigate('/login');
  await page.evaluate(() => {
    const app = document.getElementById('app').__vue_app__;
    app.config.globalProperties.$store.commit({ type: 'setAcceptedConsent', state: false });
  });
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('leticia-vuex')).hasAcceptedConsent), false);
  await page.reload(); await page.waitForSelector('#input-password');
  current = await snapshot(); assert.equal(current.accepted, false); assert.equal(current.stageIndex, 0);
  assert.equal(errors.length, 0, [...new Set(errors.map(e => e.split('\n')[0]))].join('; ')); assert.equal(blockedWrites, 0);
  console.log('OK catch-all, Vuex localStorage write/reload, no fatal bootstrap exceptions, no experimental writes');
  console.log('Browser warnings:', JSON.stringify([...new Set(warnings)]));
} finally {
  if (errors.length) console.error('Browser errors:', JSON.stringify([...new Set(errors.map(e => e.split('\n')[0]))]));
  await context.close(); await browser.close();
}
