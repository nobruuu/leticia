// BootstrapVue 2's render functions already own their native change handlers.
// Vue 3's compat `model` directive adds another handler expecting a Vue 3 model
// setter that those render functions do not supply. Keep only DOM synchronization
// hooks for these three controls; their existing handlers still update the model.
export default {
  install(app) {
    const model = app.directive('model');
    const legacyModel = {
      mounted: model.mounted,
      beforeUpdate: model.beforeUpdate,
      updated: model.updated
    };
    for (const name of ['BFormCheckbox', 'BFormRadio', 'BFormSelect']) {
      const component = app.component(name);
      const options = component.options || component;
      options.directives = { ...options.directives, model: legacyModel };
    }
  }
};
