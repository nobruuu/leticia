import './modules/compat';
import { createApp } from 'vue';
import BootstrapVue from 'bootstrap-vue';
import legacyPlugins from './modules/legacyPlugins';
import vSelect from 'vue-select';
import { createI18n } from 'vue-i18n';
import VueCookies from 'vue-cookies';

import 'bootstrap/dist/css/bootstrap.css';
import 'bootstrap-vue/dist/bootstrap-vue.css';
import 'vue-select/dist/vue-select.css';

import App from './templates/App.vue';
import { router } from './modules/routes';
import { store } from './modules/store';
import { translations } from './modules/translations';

import { library } from '@fortawesome/fontawesome-svg-core';
import { fas } from '@fortawesome/free-solid-svg-icons';
import { fab } from '@fortawesome/free-brands-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome';

import * as Constants from './services/Constants';

library.add(fas);
library.add(fab);

const i18n = createI18n({
  legacy: true,
  globalInjection: true,
  locale: Constants.locale,
  fallbackLocale: 'en',
  messages: translations
});

const app = createApp(App);
app.use(router);
app.use(store);
app.use(i18n);
app.use(BootstrapVue);
app.use(VueCookies);
app.use(legacyPlugins);
app.component('font-awesome-icon', FontAwesomeIcon);
app.component('v-select', vSelect);
app.mount('#app');
