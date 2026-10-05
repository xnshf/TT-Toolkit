import { actionButton, h } from '../../ui/dom.js';
import { createNoticeController, noticeBanner } from '../../ui/notice.js';

const MODES = [
    { id: 'floating', label: '悬浮球', badge: '默认', description: '屏幕上常驻悬浮球，可自由拖动。桌面与手机分别记忆位置。', paths: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 8v8M8 12h8'] },
    { id: 'wand', label: '魔棒菜单', badge: '沉浸', description: '从聊天输入框旁的扩展菜单打开工具箱，隐藏悬浮球，让界面更清爽。', paths: ['m3 17 12-12 4 4L7 21Z', 'm12 8 4 4', 'M5 3v4M3 5h4M18 2v4M16 4h4M21 18v4M19 20h4'] },
    { id: 'both', label: '两者都显示', badge: '双通道', description: '同时保留悬浮球与魔棒菜单项，按当前使用场景选择方便的入口。', paths: ['M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4Z', 'M8 12h8M12 8v8'] },
];
const FAILURE_REASONS = {
    HOST_WAND_EXPORT_MISSING: '宿主缺少魔棒菜单初始化接口。',
    HOST_WAND_DOM_MISSING: '宿主魔棒菜单挂载点缺失。',
    HOST_WAND_ENTRY_DUPLICATE: '检测到重复的 TT-Toolkit 魔棒入口。',
    ENTRY_SETTINGS_SAVE_FAILED: '入口设置无法保存。',
};

function icon(paths) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' }))
        svg.setAttribute(name, value);
    for (const d of paths) {
        const path = document.createElementNS(svg.namespaceURI, 'path');
        path.setAttribute('d', d);
        svg.append(path);
    }
    return svg;
}

export function mountToolkitSettingsPage(target, { entrySettings }) {
    let disposed = false;
    let busy = false;
    let savedNotice = false;
    let saved = entrySettings.getState();
    let draftMode = saved.mode;
    const labelFor = mode => MODES.find(item => item.id === mode).label;
    const feedback = h('div', { className: 'ttk-settings-feedback' });
    const warning = h('div', { className: 'ttk-settings-warning', attrs: { role: 'status' } });
    const statusText = h('span');
    const statusDot = h('span', { className: 'ttk-settings-dot', attrs: { 'aria-hidden': 'true' } });
    const status = h('div', { className: 'ttk-settings-status', attrs: { role: 'status', 'aria-live': 'polite' } }, statusDot, statusText);
    const notices = createNoticeController(() => {
        if (!disposed) { renderNotice(); sync(); }
    });
    const save = actionButton('保存入口设置', () => { void apply(); }, { className: 'ttk-settings-save' });
    const reset = actionButton('', () => {
        entrySettings.resetLayout();
        savedNotice = false;
        notices.show('界面布局已重置，入口方式与功能设置保持不变。', 'success');
        renderNotice();
        sync();
    }, { className: 'ttk-settings-reset' });
    reset.append(icon(['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5']), h('span', { text: '重置界面布局' }));
    // 原生 radio + 整张 label：保留 Tab、方向键、空格与读屏语义，不模拟点击 div。
    const cards = MODES.map(mode => {
        const radio = h('input', {
            type: 'radio', name: 'ttk-entry-mode', value: mode.id, checked: mode.id === draftMode,
            className: 'ttk-settings-radio', attrs: { 'aria-label': mode.label },
            on: { change: () => {
                if (busy || !radio.checked) return;
                draftMode = mode.id;
                if (notices.current?.kind === 'success') { notices.clear(); renderNotice(); }
                sync();
            } },
        });
        const label = h('label', { className: 'ttk-settings-entry', dataset: { mode: mode.id } },
            radio,
            h('span', { className: 'ttk-settings-card-body' },
                h('span', { className: 'ttk-settings-card-top' },
                    h('span', { className: 'ttk-settings-icon' }, icon(mode.paths)),
                    h('span', { className: 'ttk-settings-radio-mark', attrs: { 'aria-hidden': 'true' } }),
                ),
                h('span', { className: 'ttk-settings-card-title' },
                    h('strong', { text: mode.label }),
                    h('span', { className: `ttk-settings-badge${mode.id === 'floating' ? ' gold' : ''}`, text: mode.badge, attrs: { 'aria-hidden': 'true' } }),
                ),
                h('span', { className: 'ttk-settings-description', text: mode.description }),
            ),
        );
        return { label, radio };
    });
    const root = h('section', { className: 'feature-page ttk-settings' },
        h('header', { className: 'ttk-settings-header' },
            h('p', { className: 'eyebrow', text: '设置 / PREFERENCES' }),
            h('h2', { text: '界面与入口' }),
            h('p', { text: '选择打开工具箱的方式，并管理工作台与悬浮球布局。' }),
        ),
        h('section', { className: 'ttk-settings-section' },
            h('div', { className: 'ttk-settings-action-bar' }, status, save),
            warning,
            feedback,
            h('fieldset', { className: 'ttk-settings-fieldset' },
                h('legend', { text: '唤起入口方式' }),
                h('p', { className: 'ttk-settings-section-hint', text: '选择一种方式，保存后立即生效。' }),
                h('div', { className: 'ttk-settings-entry-grid' }, cards.map(item => item.label)),
            ),
        ),
        h('aside', { className: 'ttk-settings-tip' },
            h('span', { className: 'ttk-settings-tip-icon', attrs: { 'aria-hidden': 'true' }, text: '💡' }),
            h('p', {}, h('strong', { text: '魔棒菜单在哪里？' }),
                ' 它就是聊天输入框旁的扩展菜单。展开后点击“TT-Toolkit”即可打开工作台；关闭时焦点回到魔棒按钮。'),
        ),
        h('section', { className: 'ttk-settings-section' },
            h('h3', { text: '窗口与位置管理' }),
            h('div', { className: 'ttk-settings-layout' },
                h('div', {},
                    h('h4', { text: '重置工作台与悬浮球布局' }),
                    h('p', { text: '恢复工作台的默认位置与尺寸，将悬浮球移回默认位置。不改变入口方式或功能设置。' }),
                ), reset,
            ),
        ),
    );

    function renderNotice() {
        const banner = noticeBanner(notices.current, () => { notices.clear(); renderNotice(); sync(); });
        feedback.replaceChildren(...(banner ? [banner] : []));
    }

    function sync() {
        const dirty = draftMode !== saved.mode;
        root.setAttribute('aria-busy', String(busy));
        cards.forEach(({ radio }) => {
            radio.checked = radio.value === draftMode;
            radio.disabled = busy;
        });
        save.disabled = reset.disabled = busy;
        const succeeded = savedNotice && notices.current?.kind === 'success' && !dirty;
        save.classList.toggle('saved', succeeded);
        save.textContent = busy ? '正在保存……' : succeeded ? '已保存并生效' : '保存入口设置';
        statusDot.classList.toggle('pending', dirty || busy || Boolean(saved.warning));
        if (busy) statusText.textContent = `正在应用：${labelFor(draftMode)}`;
        else if (dirty) statusText.replaceChildren(
            h('span', { text: `已选择：${labelFor(draftMode)}（未保存）` }),
            h('small', { text: `${saved.warning ? '已保存' : '当前生效'}：${labelFor(saved.mode)}` }),
        );
        else statusText.textContent = `${saved.warning ? '已保存，入口待恢复' : '当前生效'}：${labelFor(saved.mode)}`;
        warning.hidden = !saved.warning;
        warning.textContent = saved.warning || '';
    }

    async function apply() {
        if (busy || disposed) return;
        busy = true;
        savedNotice = false;
        notices.clear();
        renderNotice();
        sync();
        try {
            await entrySettings.setMode(draftMode);
            if (disposed) return;
            saved = entrySettings.getState();
            draftMode = saved.mode;
            savedNotice = true;
            notices.show('入口设置已保存并立即生效。', 'success');
        } catch (error) {
            if (disposed) return;
            saved = entrySettings.getState();
            const reason = Object.hasOwn(FAILURE_REASONS, error?.code) ? FAILURE_REASONS[error.code] : '入口设置暂时无法应用。';
            // 生效入口不变，保留本次选择供重试；不展示未知错误详情。
            notices.show(`入口切换失败：${reason}原入口已保留，当前选择尚未生效。请重试；如仍失败，请重载宿主，并在“设置 / 日志”查看入口诊断。`, 'warning');
        } finally {
            busy = false;
            if (!disposed) { renderNotice(); sync(); }
        }
    }

    target.replaceChildren(root);
    sync();
    return () => {
        disposed = true;
        notices.dispose();
        target.replaceChildren();
    };
}

export function createToolkitSettingsFeature() {
    return {
        mount: mountToolkitSettingsPage,
        activate: async () => undefined,
        deactivate: async () => undefined,
    };
}
