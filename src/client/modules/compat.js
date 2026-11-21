import { configureCompat } from 'vue';

// BootstrapVue 2 and the retained Options API plugins require Vue 2 semantics.
// Keep warnings enabled while these dependencies use the Vue 3 migration build.
configureCompat({ MODE: 2 });
