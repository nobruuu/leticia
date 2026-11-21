// No API/Mongo writes. Exercise the actual Vue 2 component scripts with controlled IO.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { SourceTextModule, SyntheticModule } from 'node:vm';
import Vue from 'vue';
import lodash from 'lodash';
import EventBus from '../../client/modules/eventBus.js';
import * as coordinator from '../../client/modules/challengeCoordinator.js';
import { selectSessionFlow } from '../../server/sessionFlow.js';

const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const alerts = [];
globalThis.alert = message => alerts.push(message);
const requests = [];
let post = async () => ({ data: {} });
let get = async () => { throw new Error('Unexpected GET'); };
const axios = { post: (...args) => post(...args), get: (...args) => get(...args) };
const constants = { backendApiUrl: '/v1', backendUrl: '', currentSessionFlow: 'different-frontend-flow' };
const synthetic = values => new SyntheticModule(Object.keys(values), function() {
  for (const [key, value] of Object.entries(values)) this.setExport(key, value);
});
class Sender {
  sendGenericAction(action) { requests.push(action); return Promise.resolve({ data: {} }); }
}
class FakeTimer {
  static active = 0;
  start() { FakeTimer.active++; }
  stop() { if (!this.stopped) FakeTimer.active--; this.stopped = true; }
}
const mocks = {
  axios: { default: axios }, lodash: { ...lodash, default: lodash },
  Constants: constants, eventBus: { default: EventBus }, challengeCoordinator: coordinator,
  Utils: { deepCopy: clone, getObjectFromArray: (a, k, v) => a.find(x => x[k] === v), isEmptyArray: a => !a?.length, isArray: Array.isArray, toHHMMSS: String, getNestedValue: (o, k) => lodash.get(o, k) },
  ActionSender: { default: Sender }, Timer: { default: FakeTimer },
  ActionHandler: { default: class {} }, KeystrokeHandler: { default: class {} },
  Bookmark: { default: class {} }, MouseHandler: { default: class {} }, ScrollHandler: { default: class {} }
};
async function component(name) {
  const filename = resolve('client/templates', name + '.vue');
  const source = (await readFile(filename, 'utf8')).match(/<script>([\s\S]*?)<\/script>/)[1];
  const module = new SourceTextModule(source, { identifier: filename });
  await module.link(async specifier => {
    const key = specifier.split('/').pop().replace(/\.js$/, '');
    if (mocks[key] || mocks[specifier]) return synthetic(mocks[key] || mocks[specifier]);
    if (specifier.endsWith('.png')) return synthetic({ default: '' });
    if (specifier.endsWith('.vue')) return synthetic({ default: {} });
    throw new Error(`Unmocked import ${specifier} in ${dirname(filename)}`);
  });
  await module.evaluate();
  return module.namespace.default;
}
function instance(options, store, router = { replace: async () => {} }) {
  return new Vue({ ...options, beforeCreate() {
    this.$store = store; this.$router = router; this.$route = { query: {} };
    this.$i18n = { t: x => x };
  } });
}
const flow = { sessionFlowId: 'saved', stages: [
  { path: '/challenge', stages: [{ path: '/ready-ex', query: {} }, { path: '/search', query: {} }] },
  { path: '/end' }
] };
function store() {
  const state = { auth: { user: { username: 'flow-regression-fixture' }, status: { loggedIn: true } }, stageIndex: null, flowIndex: 0, tasks: [], stages: [], sessionFlow: clone(flow) };
  const getters = new Proxy({}, { get: (_, key) => key === 'userData' ? clone(state) : state[key] });
  return { state, getters, commit(p) {
    if (p.type === 'nextStageIndex') state.stageIndex++;
    else if (p.type === 'nextFlowIndex') state.flowIndex++;
    else state[({ setTasks: 'tasks', setStages: 'stages', setStageIndex: 'stageIndex', setFlowIndex: 'flowIndex', setSessionFlow: 'sessionFlow', setLastVisitedDoc: 'lastVisitedDoc' })[p.type]] = p.tasks ?? p.stages ?? p.amount ?? p.sessionFlow ?? p.doc;
  } };
}
async function check(name, fn) { await fn(); console.log('OK ' + name); }

await check('EventBus: synchronous on/emit, payload identity, registration order, off', () => {
  const payload = { id: 4 }, calls = [];
  const first = p => { assert.equal(p, payload); calls.push(1); };
  const second = () => calls.push(2);
  EventBus.$on('regression-event', first).$on('regression-event', second).$emit('regression-event', payload);
  assert.deepEqual(calls, [1, 2]);
  EventBus.$off('regression-event', first).$emit('regression-event', payload);
  assert.deepEqual(calls, [1, 2, 2]);
  EventBus.$off('regression-event', second);
});

await check('Coordinator: reentry replaces only previous handler, pending advance runs once', async () => {
  let old = 0, current = 0, unrelated = 0;
  const wait = deferred();
  const other = () => unrelated++;
  EventBus.$on('leticia-next-challenge', other);
  coordinator.registerChallengeCoordinator(() => old++);
  coordinator.registerChallengeCoordinator(async () => { current++; await wait.promise; });
  EventBus.$emit('leticia-next-challenge'); EventBus.$emit('leticia-next-challenge');
  await tick();
  assert.equal(old, 0); assert.equal(current, 1); assert.equal(unrelated, 2);
  wait.resolve(); await coordinator.stopChallengeCoordinator();
  EventBus.$off('leticia-next-challenge', other);
});

const Challenge = await component('Challenge');
await check('Initial assignment persists stageIndex 0/tasks/stages/flow before navigation', async () => {
  const s = store(), saved = deferred(), navigation = [];
  get = async url => { assert(url.includes('/tasks/shuffle')); return { data: [{ searchTaskId: 'task02' }, { searchTaskId: 'task01' }] }; };
  post = async (_, data) => { requests.push(clone(data)); await saved.promise; return { data: {} }; };
  const vm = instance(Challenge, s, { replace: async route => navigation.push(clone(route)) });
  const mounting = Challenge.mounted.call(vm);
  await tick();
  assert.equal(s.state.stageIndex, 0); assert.equal(navigation.length, 0);
  assert.deepEqual(requests.at(-1).state.tasks.map(t => t.searchTaskId), ['task02', 'task01']);
  assert.equal(requests.at(-1).sessionFlow.sessionFlowId, 'saved');
  saved.resolve(); await mounting;
  assert.equal(navigation[0].query.task, 'task02'); vm.$destroy();
  // Destroying Challenge must leave its coordinator available for sibling routes.
  EventBus.$emit('leticia-next-challenge'); await tick(); await coordinator.stopChallengeCoordinator();
  assert.equal(s.state.stageIndex, 1);
});

await check('Restore/reentry preserves index 0, task order and session flow without shuffle', async () => {
  const s = store(), navigation = [];
  s.state.tasks = [{ searchTaskId: 'task02' }, { searchTaskId: 'task01' }]; s.state.stageIndex = 0;
  post = async () => ({ data: {} }); get = async () => assert.fail('Restore must not fetch flow/tasks');
  let vm = instance(Challenge, s, { replace: async r => navigation.push(clone(r)) });
  vm.sessionFlow = s.state.sessionFlow; vm.createStages();
  const expected = clone(s.state.stages);
  for (let i = 0; i < 3; i++) {
    await Challenge.mounted.call(vm); vm.$destroy();
    vm = instance(Challenge, s, { replace: async r => navigation.push(clone(r)) });
  }
  assert.deepEqual(clone(s.state.stages), expected); assert.equal(navigation.length, 3);
  EventBus.$emit('leticia-next-challenge'); await tick(); await coordinator.stopChallengeCoordinator();
  assert.equal(s.state.stageIndex, 1); vm.$destroy();
});

await check('Mismatch/partial snapshot stops resume without shuffle or navigation', async () => {
  for (const partial of [false, true]) {
    const s = store(); s.state.tasks = [{ searchTaskId: 'task01' }];
    s.state.stageIndex = partial ? null : 0; s.state.stages = [{ path: '/incompatible' }];
    const vm = instance(Challenge, s, { replace: () => assert.fail('Invalid resume navigated') });
    const before = alerts.length; await Challenge.mounted.call(vm);
    assert.equal(alerts.length, before + 1); vm.$destroy(); await coordinator.stopChallengeCoordinator();
  }
});

await check('Authentication selects persisted flow and rejects assignment without one', () => {
  assert.equal(selectSessionFlow({ state: { stageIndex: 0 }, sessionFlow: flow }, { stages: [{ path: '/other' }] }), flow);
  assert.throws(() => selectSessionFlow({ state: { stageIndex: 0 }, sessionFlow: {} }, flow));
  assert.equal(selectSessionFlow({ state: {}, sessionFlow: {} }, flow), flow);
});

await check('Snapshots: slow internal write settles before global write; latest state wins', async () => {
  const s = store(), wait = deferred(), writes = [], navigation = [];
  s.state.tasks = [{ searchTaskId: 'task01' }]; s.state.stageIndex = 0;
  const vm = instance(Challenge, s, { replace: async r => navigation.push(r) });
  vm.sessionFlow = s.state.sessionFlow; vm.createStages();
  const App = await component('App'); instance(App, s, { replace: async r => navigation.push(r) });
  let persisted;
  post = async (_, data) => {
    const snapshot = clone(data); writes.push(snapshot);
    if (writes.length === 1) await wait.promise;
    persisted = snapshot; return { data: {} };
  };
  EventBus.$emit('leticia-next-challenge'); await tick();
  EventBus.$emit('leticia-next-stage'); EventBus.$emit('leticia-next-stage'); await tick();
  assert.equal(writes.length, 1); assert.equal(navigation.length, 0);
  wait.resolve(); await tick(); await tick();
  assert.equal(writes.length, 2); assert.equal(persisted.state.flowIndex, 1);
  assert.equal(persisted.state.stageIndex, 1); assert.equal(navigation.at(-1).path, '/end');
  vm.$destroy(); EventBus.$off('leticia-next-stage'); EventBus.$off('leticia-timeout');
});

await check('Failed snapshot blocks navigation and restores previous stage index', async () => {
  const s = store(); s.state.stageIndex = 0; s.state.tasks = [{ searchTaskId: 'task01' }];
  const vm = instance(Challenge, s, { replace: () => assert.fail('Failed save navigated') });
  vm.sessionFlow = flow; vm.createStages();
  post = async () => { throw new Error('Expected failed write'); };
  EventBus.$emit('leticia-next-challenge'); await tick(); await coordinator.stopChallengeCoordinator();
  assert.equal(s.state.stageIndex, 0); vm.$destroy();
});

await check('Document click stores selection before Router navigation; no params.doc', async () => {
  for (const name of ['SearchModule', 'search/SearchModule']) {
    const Search = await component(name), s = store(), doc = { docId_s: 'doc02', path_s: '/documents/doc02' };
    const receiver = { $store: s, actionHandler: { searchResultClick: () => ({ type: 'SearchResultClick' }) }, sender: new Sender(), $router: { push: async route => {
      assert.equal(s.state.lastVisitedDoc, doc); assert.equal(route.query.id, doc.docId_s); assert.equal(route.params, undefined);
    } } };
    await Search.methods.searchResultClick.call(receiver, { preventDefault() {} }, doc);
    for (const click of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) {
      const modified = { ...receiver, $router: { push: () => assert.fail('Modified click must not use SPA navigation') } };
      await Search.methods.searchResultClick.call(modified, { ...click, preventDefault: () => assert.fail('Modified click must keep browser default') }, doc);
    }
  }
});

await check('DisplayPage only accepts selected document matching query.id; invalid teardown is safe', async () => {
  const Page = await component('search/DisplayPage');
  const s = store(), vm = instance(Page, s);
  s.state.lastVisitedDoc = { docId_s: 'doc01', path_s: '/doc01' };
  vm.$route.query.id = 'doc01'; vm.visitPage(); assert.equal(vm.renderPage, true); assert.equal(vm.doc.docId_s, 'doc01');
  for (const id of ['doc02', undefined, ['doc01']]) {
    vm.$route.query.id = id; vm.visitPage(); assert.equal(vm.renderPage, false); assert.equal(vm.pageUrl, '');
  }
  s.state.lastVisitedDoc = null; vm.$route.query.id = 'doc01'; vm.visitPage(); assert.equal(vm.renderPage, false);
  vm.$destroy();
});

await check('UserHub saves once before starting timer/navigation on repeated resume clicks', async () => {
  const Hub = await component('hubs/UserHub'), s = store(), wait = deferred();
  s.state.sessionFlow.stages[0].timeLimit = 30; s.state.timerTime = 600;
  let saves = 0, timers = 0, navigations = 0;
  post = async () => { saves++; await wait.promise; return { data: {} }; };
  const handler = () => timers++;
  EventBus.$on('leticia-timer-create', handler);
  const vm = instance(Hub, s, { replace: async () => navigations++ });
  const pending = vm.resumeStudy(); vm.resumeStudy(); await tick();
  assert.equal(saves, 1); assert.equal(timers, 0); assert.equal(navigations, 0);
  wait.resolve(); await pending;
  assert.equal(timers, 1); assert.equal(navigations, 1);
  EventBus.$off('leticia-timer-create', handler); vm.$destroy();
});

await check('Navbar timer creation stops previous instance', async () => {
  const Navbar = await component('Navbar'), vm = instance(Navbar, store());
  for (let i = 0; i < 4; i++) EventBus.$emit('leticia-timer-create', { totalTime: 60 });
  assert.equal(FakeTimer.active, 1); EventBus.$emit('leticia-timer-stop'); assert.equal(FakeTimer.active, 0);
  vm.$destroy();
});
console.log('Flow directed component checks passed (controlled IO, no database writes).');
