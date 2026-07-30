import type { Directive, DirectiveBinding } from 'vue';

// localStorage 中存放用户的键（与 stores/auth.ts 保持一致）
const LS_USER = 'lxdoc_user';

/**
 * v-permission 指令：基于 localStorage 中的用户角色控制元素显隐
 * 用法：
 *   v-permission="'admin'"
 *   v-permission="['editor','admin']"
 * 若用户角色不在允许列表中，则从 DOM 中移除该元素
 */
export const vPermission: Directive<HTMLElement, string | string[]> = {
  mounted(el: HTMLElement, binding: DirectiveBinding<string | string[]>) {
    const userJson = localStorage.getItem(LS_USER);
    if (!userJson) {
      el.parentNode?.removeChild(el);
      return;
    }
    let role: string | undefined;
    try {
      const user = JSON.parse(userJson) as { role?: string };
      role = user.role;
    } catch {
      el.parentNode?.removeChild(el);
      return;
    }
    const required = Array.isArray(binding.value) ? binding.value : [binding.value];
    if (!role || !required.includes(role)) {
      el.parentNode?.removeChild(el);
    }
  },
};
