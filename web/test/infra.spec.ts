/**
 * 前端测试基础设施验证
 * 确认 vitest + @vue/test-utils + happy-dom 配置正确。
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent } from 'vue';

describe('前端测试基础设施', () => {
  it('vitest + happy-dom 工作', () => {
    expect(1 + 1).toBe(2);
    expect(document).toBeDefined();
    expect(window).toBeDefined();
  });

  it('Vue 组件可挂载', () => {
    const Hello = defineComponent({
      template: '<div class="hello">{{ msg }}</div>',
      props: { msg: { type: String, required: true } },
    });
    const wrapper = mount(Hello, { props: { msg: '你好' } });
    expect(wrapper.text()).toBe('你好');
    expect(wrapper.classes()).toContain('hello');
  });

  it('async/await 工作', async () => {
    const result = await Promise.resolve('hello');
    expect(result).toBe('hello');
  });
});
