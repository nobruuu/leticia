import CompatVue from 'vue';
import VeeValidate from 'vee-validate';
import VueAxios from 'vue-axios';
import Axios from 'axios';

// VeeValidate 2 constructs an internal reactive Vue instance; vue-axios 2
// installs prototype getters. Bridge only these installers to the compat
// constructor and this app's registrations. The application uses createApp.
export default {
  install(app) {
    function LegacyVue(options) { return new CompatVue(options); }
    LegacyVue.prototype = app.config.globalProperties;
    // VeeValidate's hooks also inspect Vue 2's private constructor/VNode shape.
    // Adapt only their receiver, keeping Vue 3's VNodes and other plugins intact.
    const legacyHook = hook => function (...args) {
      this.$options._base = CompatVue;
      const vm = this;
      const receiver = new Proxy(vm, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (key !== '$vnode' || !value || value.componentOptions) return value;
          return { ...value, componentOptions: { tag: value.type?.name || '' } };
        }
      });
      return hook.apply(receiver, args);
    };
    LegacyVue.mixin = mixin => {
      app.mixin({ ...mixin,
        beforeCreate: legacyHook(mixin.beforeCreate),
        provide: legacyHook(mixin.provide)
      });
      return LegacyVue;
    };
    LegacyVue.directive = (...args) => app.directive(...args);
    VeeValidate.install(LegacyVue);
    VueAxios(LegacyVue, Axios);
  }
};
