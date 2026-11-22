import assert from 'node:assert/strict';

// Helpers injected only into test browser contexts; no application globals added.
export async function installRuntimeHelpers(context) {
  await context.addInitScript(() => {
    if (window !== window.top) return;
    const app = () => document.getElementById('app')?.__vue_app__;
    // Public app.config.globalProperties provides router/store. Component-owned
    // timer/validator state has no public lookup API: keep VNode traversal here.
    const rootInstance = () => app()?._container?._vnode?.component;
    function find(vnode, name) {
      if (!vnode) return null;
      if (vnode.component) {
        const instance = vnode.component;
        if (instance.type.name === name || instance.proxy?.$options.name === name) return instance.proxy;
        const found = find(instance.subTree, name);
        if (found) return found;
      }
      if (Array.isArray(vnode.children)) for (const child of vnode.children) {
        const found = find(child, name);
        if (found) return found;
      }
      return null;
    }
    window.flowTestRuntime = {
      app,
      globals: () => app().config.globalProperties,
      root: () => rootInstance().proxy,
      component: name => find(app()._container._vnode, name),
      // The compat constructor exposes Vue 3 factories. Needed solely to mount
      // real Search leaf components in isolation for modifier-click assertions.
      vue: () => rootInstance().proxy.$options._base
    };
  });
}

// These two absolute font references belong to the retained offline MDN corpus,
// not to the Vue bundle. Keep reporting them, but reject any new resource error.
export function assertResourceErrors(messages, expectedSnapshotFailure = false) {
  for (const message of messages) {
    const font = message.includes('404') && /\/static\/client\/(?:jetbrains-mono-latin\.119994ed445212c7|inter-latin\.9a3b1bc220d426ef)\.woff2/.test(message);
    const snapshot = expectedSnapshotFailure && message.includes('503') && message.includes('/v1/userdata/flow-browser-fixture');
    assert(font || snapshot, `Unexpected resource error: ${message}`);
  }
}
