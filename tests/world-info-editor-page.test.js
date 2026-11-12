import { describe, expect, it, vi } from 'vitest';
import { mountWorldInfoEditorPage } from '../src/features/world-info-editor/WorldInfoEditorPage.js';
import { WorldInfoEditorRuntime } from '../src/features/world-info-editor/runtime.js';

function createMockHost() {
    const store = {
        MyLore: {
            entries: {
                1: { uid: 1, comment: '帝国圣殿骑士团', key: ['骑士', '圣殿'], keysecondary: ['高文'], selective: true, content: '骑士团背景设定正文', constant: true, disable: false, order: 100 },
                2: { uid: 2, comment: '皇家大图书馆', key: ['图书馆'], keysecondary: [], selective: false, content: '图书馆藏书', constant: false, disable: true, order: 120 },
            },
        },
    };
    return {
        listWorldInfoNames: vi.fn(() => ['MyLore']),
        activeWorldInfoBindings: vi.fn(() => [{ name: 'MyLore', source: 'chat' }]),
        loadWorldInfoFresh: vi.fn(async name => structuredClone(store[name] ?? null)),
        saveWorldInfo: vi.fn(async (name, data) => { store[name] = structuredClone(data); }),
        globalGet: vi.fn(async () => undefined),
        globalSet: vi.fn(async () => undefined),
        globalDelete: vi.fn(async () => undefined),
        _store: store,
    };
}

describe('WorldInfoEditorPage', () => {
    it('mounts into DOM, displays header and handles master toggle', async () => {
        const target = document.createElement('div');
        const host = createMockHost();
        const runtime = new WorldInfoEditorRuntime(host);
        const setEnabled = vi.fn();

        const unmount = mountWorldInfoEditorPage(target, {
            runtime,
            enabled: false,
            setEnabled,
            closeWorkbench: vi.fn(),
        });

        // 默认未启用时渲染警告提示
        expect(target.textContent).toContain('功能尚未启用');
        expect(target.querySelector('.master-toggle input[type="checkbox"]').checked).toBe(false);

        // 模拟点击启用
        const toggle = target.querySelector('.master-toggle input[type="checkbox"]');
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));

        expect(setEnabled).toHaveBeenCalledWith(true);
        unmount();
    });

    it('renders full dual-pane editor when enabled and allows field updates', async () => {
        const target = document.createElement('div');
        const host = createMockHost();
        const runtime = new WorldInfoEditorRuntime(host);

        const unmount = mountWorldInfoEditorPage(target, {
            runtime,
            enabled: true,
            setEnabled: vi.fn(),
            closeWorkbench: vi.fn(),
        });

        // 等待异步宿主读取完成
        await vi.waitFor(() => expect(target.querySelectorAll('.wie-card')).toHaveLength(2));

        // 验证顶栏世界书选择与统计
        const select = target.querySelector('.wie-select');
        expect(select).not.toBeNull();
        expect(target.textContent).toContain('共 2 条目');
        expect(target.textContent).toContain('1 常驻');

        // 验证卡片列表渲染
        const cards = target.querySelectorAll('.wie-card');
        expect(cards).toHaveLength(2);
        expect(cards[0].textContent).toContain('帝国圣殿骑士团');
        expect(cards[1].textContent).toContain('皇家大图书馆');

        // 验证当前选中的详情表单
        const commentInput = target.querySelector('.wie-form-row input[type="text"]');
        expect(commentInput).not.toBeNull();
        expect(commentInput.value).toBe('帝国圣殿骑士团');

        // 验证正文文本域
        const textarea = target.querySelector('.wie-textarea');
        expect(textarea).not.toBeNull();
        expect(textarea.value).toBe('骑士团背景设定正文');

        // 修改标题字段
        commentInput.value = '圣殿骑士团重编版';
        commentInput.dispatchEvent(new Event('input'));

        expect(runtime.state.currentDraft.comment).toBe('圣殿骑士团重编版');
        expect(runtime.state.dirty).toBe(true);

        // 点击保存按钮
        const saveBtn = Array.from(target.querySelectorAll('button')).find(b => b.textContent.includes('保存'));
        expect(saveBtn).toBeDefined();
        saveBtn.click();

        await vi.waitFor(() => expect(host.saveWorldInfo).toHaveBeenCalled());
        expect(runtime.state.dirty).toBe(false);

        unmount();
    });


    it('rejects empty or out-of-range numbers instead of writing 0', async () => {
        const target = document.createElement('div');
        document.body.append(target);
        const host = createMockHost();
        const runtime = new WorldInfoEditorRuntime(host);
        const dispose = mountWorldInfoEditorPage(target, { runtime, enabled: true, setEnabled: vi.fn() });
        try {
            await vi.waitFor(() => expect(target.querySelectorAll('.wie-card')).toHaveLength(2));

            // Number('') === 0：清空排序输入框不能把条目静默改成 0。
            const order = target.querySelector('[data-field="order"]');
            expect(order.value).toBe('100');
            order.value = '';
            order.dispatchEvent(new Event('input'));
            expect(runtime.state.currentDraft.order).toBe(100);
            expect(runtime.state.dirty).toBe(false);

            // 失焦回退到最后一次合法值，避免界面停在空值。
            order.dispatchEvent(new Event('blur'));
            expect(order.value).toBe('100');

            // 超出范围的概率不进入草稿。
            const probability = target.querySelector('[data-field="probability"]');
            probability.value = '0';
            probability.dispatchEvent(new Event('input'));
            expect(probability.classList.contains('wie-input-invalid')).toBe(true);
            expect(runtime.state.currentDraft.probability).toBeUndefined();

            probability.value = '55';
            probability.dispatchEvent(new Event('input'));
            expect(runtime.state.currentDraft.probability).toBe(55);
        }
        finally {
            dispose();
            target.remove();
        }
    });

    it('preserves focus and caret through typing, search and an autosave notification', async () => {
        const target = document.createElement('div');
        document.body.append(target);
        const host = createMockHost();
        const runtime = new WorldInfoEditorRuntime(host);
        const dispose = mountWorldInfoEditorPage(target, { runtime, enabled: true, setEnabled: vi.fn() });
        try {
            await vi.waitFor(() => expect(target.querySelectorAll('.wie-card')).toHaveLength(2));
            const comment = target.querySelector('.wie-form-row input[type="text"]');
            comment.focus();
            comment.value = '新的标题';
            comment.setSelectionRange(2, 2);
            comment.dispatchEvent(new Event('input'));
            expect(target.querySelector('.wie-form-row input[type="text"]')).toBe(comment);
            expect(document.activeElement).toBe(comment);
            expect(comment.selectionStart).toBe(2);
            await runtime.saveCurrentDraft();
            expect(target.querySelector('.wie-form-row input[type="text"]')).toBe(comment);
            expect(document.activeElement).toBe(comment);
            const search = target.querySelector('.wie-search-box input');
            search.focus();
            search.value = '图书馆';
            search.dispatchEvent(new Event('input'));
            expect(target.querySelector('.wie-search-box input')).toBe(search);
            expect(document.activeElement).toBe(search);
            expect(target.querySelectorAll('.wie-card')).toHaveLength(1);
        }
        finally { dispose(); target.remove(); }
    });

    it('switches active entry when clicking cards in list', async () => {
        const target = document.createElement('div');
        const host = createMockHost();
        const runtime = new WorldInfoEditorRuntime(host);

        const unmount = mountWorldInfoEditorPage(target, {
            runtime,
            enabled: true,
            setEnabled: vi.fn(),
            closeWorkbench: vi.fn(),
        });

        await vi.waitFor(() => expect(target.querySelectorAll('.wie-card')).toHaveLength(2));

        const cards = target.querySelectorAll('.wie-card');
        // 点击第二张卡片 (皇家大图书馆)
        cards[1].click();

        await vi.waitFor(() => expect(runtime.state.selectedUid).toBe(2));
        const commentInput = target.querySelector('.wie-form-row input[type="text"]');
        expect(commentInput.value).toBe('皇家大图书馆');

        unmount();
    });

    it('renders the user-macro save option in the top bar and persists toggles', async () => {        const target = document.createElement('div');
        const host = createMockHost();
        const runtime = new WorldInfoEditorRuntime(host);
        const unmount = mountWorldInfoEditorPage(target, { runtime, enabled: true, setEnabled: vi.fn() });
        try {
            await vi.waitFor(() => expect(target.querySelectorAll('.wie-card')).toHaveLength(2));
            const option = target.querySelector('.wie-save-option input[type="checkbox"]');
            expect(option).not.toBeNull();
            expect(option.checked).toBe(true);

            option.checked = false;
            option.dispatchEvent(new Event('change'));
            await vi.waitFor(() => expect(host.globalSet).toHaveBeenCalledWith('world-info-editor-settings-v1', { schemaVersion: 1, convertUserMacro: false }));
            expect(runtime.state.settings.convertUserMacro).toBe(false);
        }
        finally { unmount(); }
    });

    it('wraps the textarea selection with paired macros and inserts the rest at the caret', async () => {
        const target = document.createElement('div');
        document.body.append(target);
        const host = createMockHost();
        const runtime = new WorldInfoEditorRuntime(host);
        const unmount = mountWorldInfoEditorPage(target, { runtime, enabled: true, setEnabled: vi.fn() });
        try {
            await vi.waitFor(() => expect(target.querySelectorAll('.wie-card')).toHaveLength(2));
            const textarea = target.querySelector('.wie-textarea');
            // 真实路径：用户先点进正文，再点宏按键。
            textarea.focus();
            const macroKeys = [...target.querySelectorAll('.wie-macro-key')];
            expect(macroKeys.map(key => key.textContent)).toEqual([
                '{{char}}', '{{user}}', '[[', ']]', '*动作*', '"对话"',
            ]);

            // 有选区时成对宏包裹选区，不冲掉原文，并保留选中。
            textarea.value = '骑士团誓言';
            textarea.selectionStart = 0;
            textarea.selectionEnd = 3;
            macroKeys[2].click();
            expect(textarea.value).toBe('[[骑士团]]誓言');
            expect(textarea.selectionStart).toBe(2);
            expect(textarea.selectionEnd).toBe(5);
            expect(runtime.state.currentDraft.content).toBe('[[骑士团]]誓言');

            // 无选区时按光标位置插入，并保留焦点。
            textarea.value = '正文';
            textarea.selectionStart = 2;
            textarea.selectionEnd = 2;
            macroKeys[0].click();
            expect(textarea.value).toBe('正文{{char}}');
            expect(document.activeElement).toBe(textarea);
            expect(target.querySelector('.wie-textarea')).toBe(textarea);
            expect(runtime.state.currentDraft.content).toBe('正文{{char}}');
        }
        finally { unmount(); target.remove(); }
    });

    it('commits a pending trigger word on blur without rebuilding the input', async () => {
        const target = document.createElement('div');
        document.body.append(target);
        const host = createMockHost();
        const runtime = new WorldInfoEditorRuntime(host);
        const unmount = mountWorldInfoEditorPage(target, { runtime, enabled: true, setEnabled: vi.fn() });
        try {
            await vi.waitFor(() => expect(target.querySelectorAll('.wie-card')).toHaveLength(2));
            const tagInput = target.querySelector('.wie-tag-box .wie-tag-input');
            tagInput.value = '誓约';
            // 手机输入法没有可靠的回车/逗号：失焦即成块，避免输入被静默丢弃。
            tagInput.focus();
            tagInput.dispatchEvent(new Event('blur'));
            expect(runtime.state.currentDraft.key).toEqual(['骑士', '圣殿', '誓约']);
            expect(tagInput.value).toBe('');
            expect(target.querySelector('.wie-tag-box .wie-tag-input')).toBe(tagInput);

            // 成块后只重建词条块，输入框与光标不被替换（移动端键盘不闪断）。
            tagInput.value = '骑士团';
            tagInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            expect(runtime.state.currentDraft.key).toEqual(['骑士', '圣殿', '誓约', '骑士团']);
            expect(target.querySelector('.wie-tag-box .wie-tag-input')).toBe(tagInput);

            // 删除按钮只移除对应词条（主触发词 4 个 + 二级词 1 个）。
            const removeButtons = target.querySelectorAll('.wie-tag-list .wie-tag-remove');
            expect(removeButtons).toHaveLength(5);
            removeButtons[3].click();
            expect(runtime.state.currentDraft.key).toEqual(['骑士', '圣殿', '誓约']);
            expect(runtime.state.currentDraft.keysecondary).toEqual(['高文']);
            expect(target.querySelector('.wie-tag-box .wie-tag-input')).toBe(tagInput);
        }
        finally { unmount(); target.remove(); }
    });

    it('saves a dirty draft before returning to the list on mobile', async () => {
        const target = document.createElement('div');
        document.body.append(target);
        const host = createMockHost();
        const runtime = new WorldInfoEditorRuntime(host);
        const unmount = mountWorldInfoEditorPage(target, { runtime, enabled: true, setEnabled: vi.fn() });
        try {
            await vi.waitFor(() => expect(target.querySelectorAll('.wie-card')).toHaveLength(2));
            runtime.updateDraftField('comment', '未保存的标题');
            expect(runtime.state.dirty).toBe(true);

            // 窄容器顶部栏的保存标记与详情头部同源，未保存时可见。
            const saveChip = target.querySelector('.wie-mobile-save');
            expect(saveChip.textContent).toContain('未保存修改');

            const backButton = [...target.querySelectorAll('button')].find(button => button.textContent.includes('返回列表'));
            backButton.click();
            await vi.waitFor(() => expect(host.saveWorldInfo).toHaveBeenCalled());
            expect(runtime.state.dirty).toBe(false);
            expect(host._store.MyLore.entries[1].comment).toBe('未保存的标题');
        }
        finally { unmount(); target.remove(); }
    });
});

describe('WorldInfoEditorPage image separation', () => {
    it('leaves image management to the independent feature', async () => {
        const target = document.createElement('div');
        const runtime = new WorldInfoEditorRuntime(createMockHost());
        const unmount = mountWorldInfoEditorPage(target, { runtime, enabled: true, setEnabled: vi.fn() });
        try {
            await vi.waitFor(() => expect(target.querySelectorAll('.wie-card')).toHaveLength(2));
            expect(target.textContent).not.toContain('条目图片');
            expect(target.querySelector('input[type=file]')).toBeNull();
        } finally { unmount(); }
    });
});
