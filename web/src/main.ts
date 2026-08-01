import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import * as ElementPlusIconsVue from '@element-plus/icons-vue';

// LXDOC 设计令牌 + 全局样式（必须在 Element Plus 之后引入以覆盖其变量）
import './styles/tokens.css';
import './styles/global.css';

import App from './App.vue';
import router from './router';
import { vPermission } from './directives/permission';

const app = createApp(App);

// 注册 Pinia 状态管理
app.use(createPinia());
// 注册 Vue Router
app.use(router);
// 注册 Element Plus 组件库
app.use(ElementPlus);

// 全局注册权限指令 v-permission
app.directive('permission', vPermission);

// 全局注册所有 Element Plus 图标组件
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component);
}

app.mount('#app');
