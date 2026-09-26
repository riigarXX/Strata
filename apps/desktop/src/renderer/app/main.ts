// Primero: Zod decide su modo al construir los schemas, y `App` los importa (ver zod-jitless.ts).
import '@strata/contracts/zod-jitless'
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'

createApp(App).use(createPinia()).mount('#app')
