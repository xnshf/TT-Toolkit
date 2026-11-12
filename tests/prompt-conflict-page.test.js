import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountPromptConflictPage } from '../src/features/prompt-conflict/page.js';

const mounted = [];

afterEach(() => {
    for (const entry of mounted.splice(0))
        entry.dispose();
});

function source(overrides = {}) {
    return {
        sourceId: 'preset:main',
        sourceType: 'preset',
        label: 'Main 提示词',
        role: 'system',
        position: 0,
        order: 100,
        content: '保持简洁，不要重复。',
        contentDigest: 'a'.repeat(64),
        enabledForDetection: true,
        suppressedForCurrentChat: false,
        dynamic: false,
        actionable: false,
        ...overrides,
    };
}

function worldSource(overrides = {}) {
    return {
        sourceId: 'wi:lore:1',
        sourceType: 'world-info',
        worldDigest: 'b'.repeat(64),
        uid: 1,
        worldName: 'Lore',
        label: '世界条目',
        position: 0,
        order: 10,
        content: '常驻内容',
        contentDigest: 'c'.repeat(64),
        rawContentDigest: 'd'.repeat(64),
        enabledForDetection: true,
        suppressedForCurrentChat: false,
        dynamic: false,
        actionable: true,
        ...overrides,
    };
}

function report(overrides = {}) {
    return {
        reportId: 'run-1',
        snapshotFingerprint: 'f'.repeat(64),
        selection: [{ sourceId: 'preset:main', contentDigest: 'a'.repeat(64) }],
        startedAt: Date.now() - 5000,
        finishedAt: Date.now(),
        sourceIds: ['preset:main'],
        batches: 1,
        calls: 2,
        directives: [
            { directiveId: 'preset:main#a1', sourceId: 'preset:main', kind: 'requirement', statement: '保持简洁', condition: null, evidence: ['保持简洁'] },
        ],
        conflicts: [
            { directiveIds: ['preset:main#a1', 'wi:lore:1#b1'], severity: 'high', category: 'contradiction', title: '角色定位矛盾', explanation: '两个来源互相否定。', options: [{ label: '保留预设', consequence: '世界书定位不再生效。', sourceIds: ['preset:main'] }] },
        ],
        counts: { high: 1, medium: 0, low: 0 },
        ...overrides,
    };
}

function state(overrides = {}) {
    return {
        phase: 'idle',
        chatIdentity: { stableId: 'chat-1', label: 'Test chat' },
        snapshot: {
            fingerprint: 'e'.repeat(64),
            identity: { stableId: 'chat-1', label: 'Test chat' },
            sources: [source(), worldSource()],
        },
        selectedSourceIds: new Set(['preset:main', 'wi:lore:1']),
        stagedChanges: new Map(),
        report: null,
        reportStale: false,
        activeRun: null,
        selectedModelPresetId: null,
        presetOptions: [{ id: 'p1', name: 'Local', model: 'model-a' }],
        activePresetId: 'p1',
        presetError: '',
        metadataError: '',
        error: '',
        status: 'ready',
        applying: false,
        ...overrides,
    };
}

function runtime(overrides = {}) {
    const current = state(overrides.state);
    let listener = null;
    const mock = {
        state: current,
        subscribe: vi.fn(callback => {
            listener = callback;
            return () => { listener = null; };
        }),
        notify: vi.fn(() => listener?.(mock.state)),
        refresh: vi.fn(async () => undefined),
        setSourceSelected: vi.fn(async () => undefined),
        selectAllAnalyzable: vi.fn(async () => undefined),
        clearSelection: vi.fn(async () => undefined),
        stageSuppress: vi.fn(),
        stageRestore: vi.fn(),
        stageRestoreRecord: vi.fn(),
        clearStagedChanges: vi.fn(),
        beginApplyReview: vi.fn(async () => undefined),
        cancelApplyReview: vi.fn(),
        commitStagedChanges: vi.fn(async () => undefined),
        runDetection: vi.fn(),
        cancelRun: vi.fn(),
        resetChatMetadata: vi.fn(async () => undefined),
        selectPreset: vi.fn(async () => undefined),
        snapshotSources: vi.fn(() => current.snapshot?.sources ?? []),
        analyzableSources: vi.fn(() => (current.snapshot?.sources ?? []).filter(item => !item.suppressedForCurrentChat && !item.dynamic)),
        selectedSources: vi.fn(() => {
            const selected = new Set(current.selectedSourceIds);
            return (current.snapshot?.sources ?? []).filter(item => !item.suppressedForCurrentChat && !item.dynamic && selected.has(item.sourceId));
        }),
        ...overrides.methods,
    };
    return mock;
}

function mount(options = {}) {
    const target = document.createElement('div');
    const mock = runtime(options);
    const dispose = mountPromptConflictPage(target, { runtime: mock, enabled: options.enabled ?? true, setEnabled: options.setEnabled ?? vi.fn() });
    const entry = { target, mock, dispose };
    mounted.push(entry);
    return entry;
}

function clickByText(target, text) {
    const button = [...target.querySelectorAll('button')].find(item => item.textContent === text || item.textContent?.startsWith(text));
    if (!button)
        throw new Error(`Button not found: ${text}`);
    button.click();
    return button;
}

describe('prompt conflict page shell', () => {
    it('renders controls, counts, preset selection and both tabs', () => {
        const { target } = mount();
        expect(target.textContent).toContain('冲突检测');
        expect(target.textContent).toContain('可检测 2 · 已屏蔽 0 · 不支持 0');
        expect(target.textContent).toContain('预计模型调用 2 次');
        expect(target.querySelectorAll('[role="tab"]')).toHaveLength(2);
        expect(target.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('检测范围');
        const select = target.querySelector('.pc-preset');
        expect([...select.options].map(option => option.textContent)).toContain('跟随当前预设（Local）');
    });

    it('groups sources by preset, world info, suppressed and unsupported', () => {
        const { target } = mount({
            state: {
                snapshot: { fingerprint: 'e'.repeat(64), sources: [
                    source(),
                    worldSource(),
                    worldSource({ sourceId: 'wi:lore:2', uid: 2, suppressedForCurrentChat: true, enabledForDetection: false }),
                    source({ sourceId: 'preset:dyn', label: '动态', dynamic: true, content: '<%- x %>', enabledForDetection: false }),
                ] },
                selectedSourceIds: new Set(['preset:main', 'wi:lore:1']),
            },
        });
        const titles = [...target.querySelectorAll('.pc-group-title')].map(item => item.textContent);
        expect(titles).toEqual(['预设提示词 1', '生效的常驻世界书 1', '当前聊天已屏蔽 1', '无法静态检测 1']);
        const badges = [...target.querySelectorAll('.pc-badge')].map(item => item.textContent);
        expect(badges).toEqual(['预设', '世界书', '世界书', '预设']);
    });

    it('keeps unsupported and suppressed rows from selection but allows restore', () => {
        const { target, mock } = mount({
            state: {
                snapshot: { fingerprint: 'e'.repeat(64), sources: [
                    source(),
                    worldSource({ suppressedForCurrentChat: true, enabledForDetection: false }),
                    source({ sourceId: 'preset:dyn', dynamic: true, enabledForDetection: false }),
                ] },
                selectedSourceIds: new Set(['preset:main']),
            },
        });
        const checks = [...target.querySelectorAll('.pc-source-check')];
        expect(checks[0].disabled).toBe(false);
        expect(checks[1].disabled).toBe(true);
        expect(checks[2].disabled).toBe(true);
        clickByText(target, '暂存恢复');
        expect(mock.stageRestore).toHaveBeenCalledWith('wi:lore:1');
    });

    it('search matches name and full text and the source filter narrows the list', () => {
        const { target } = mount();
        const search = target.querySelector('.pc-search');
        search.value = '常驻';
        search.dispatchEvent(new Event('input'));
        expect(target.querySelectorAll('.pc-source')).toHaveLength(1);
        expect(target.textContent).toContain('世界条目');
        expect(target.textContent).not.toContain('Main 提示词');
        search.value = '';
        search.dispatchEvent(new Event('input'));
        const filter = target.querySelector('.pc-source-filter');
        filter.value = 'preset';
        filter.dispatchEvent(new Event('change'));
        expect(target.textContent).toContain('Main 提示词');
        expect(target.textContent).not.toContain('世界条目');
    });

    it('renders expanded content only through text nodes', () => {
        const { target } = mount({
            state: {
                snapshot: { fingerprint: 'e'.repeat(64), sources: [source({ content: '<img src=x onerror=alert(1)> 正文' })] },
                selectedSourceIds: new Set(['preset:main']),
            },
        });
        clickByText(target, '展开');
        const pre = target.querySelector('.pc-source-content');
        expect(pre).not.toBeNull();
        expect(pre.childNodes).toHaveLength(1);
        expect(pre.childNodes[0].nodeType).toBe(Node.TEXT_NODE);
        expect(pre.textContent).toContain('<img');
        expect(target.querySelector('img')).toBeNull();
        const toggle = target.querySelector('.pc-expand');
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
    });

    it('selects and clears via checkboxes and bulk actions', () => {
        const { target, mock } = mount();
        const check = target.querySelector('.pc-source-check');
        check.checked = false;
        check.dispatchEvent(new Event('change'));
        expect(mock.setSourceSelected).toHaveBeenCalledWith('preset:main', false);
        clickByText(target, '全选当前有效来源');
        expect(mock.selectAllAnalyzable).toHaveBeenCalledOnce();
        clickByText(target, '清空选择');
        expect(mock.clearSelection).toHaveBeenCalledOnce();
    });
});

describe('prompt conflict page results and staging', () => {
    it('switches to results automatically when a report arrives and renders conflict cards', () => {
        const { target } = mount({ state: { report: report() } });
        expect(target.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('检测结果');
        expect(target.textContent).toContain('1 批提取 + 1 次比较 = 2 次模型调用');
        expect([...target.querySelectorAll('span')].some(node => node.textContent.trim().endsWith('高'))).toBe(true);
        expect(target.textContent).toContain('角色定位矛盾');
        expect(target.textContent).toContain('涉及来源：2 个');
        clickByText(target, '展开');
        expect(target.textContent).toContain('冲突解释');
        expect(target.textContent).toContain('两个来源互相否定。');
        expect(target.textContent).toContain('保持简洁');
        expect(target.querySelector('.pc-evidence code')?.textContent).toBe('保持简洁');
    });

    it('shows a clear no-conflict conclusion with scope counts', () => {
        const { target } = mount({ state: { report: report({ conflicts: [], counts: { high: 0, medium: 0, low: 0 } }) } });
        expect(target.textContent).toContain('在本次检测范围内未发现冲突');
        expect(target.textContent).toContain('临时排除 1 个');
    });

    it('disables report actions when stale and shows the stale banner', () => {
        const { target } = mount({
            state: {
                report: report(),
                reportStale: true,
                snapshot: { fingerprint: 'other'.repeat(20), sources: [source(), worldSource()] },
                selectedSourceIds: new Set(['preset:main', 'wi:lore:1']),
            },
        });
        expect(target.textContent).toContain('报告已过期');
        clickByText(target, '展开');
        const suppress = [...target.querySelectorAll('button')].find(button => button.textContent?.startsWith('暂存屏蔽'));
        expect(suppress).not.toBeUndefined();
        expect(suppress.disabled).toBe(true);
    });

    it('filters conflicts by severity and category', () => {
        const { target } = mount({
            state: {
                report: report({
                    conflicts: [
                        report().conflicts[0],
                        { ...report().conflicts[0], directiveIds: ['preset:main#a1', 'wi:lore:1#b2'], severity: 'low', category: 'style', title: '风格拉扯' },
                    ],
                    counts: { high: 1, medium: 0, low: 1 },
                }),
            },
        });
        expect(target.querySelectorAll('.pc-conflict')).toHaveLength(2);
        const severity = [...target.querySelectorAll('.pc-summary-filters select')][0];
        severity.value = 'low';
        severity.dispatchEvent(new Event('change'));
        expect(target.querySelectorAll('.pc-conflict')).toHaveLength(1);
        expect(target.textContent).toContain('风格拉扯');
        const category = [...target.querySelectorAll('.pc-summary-filters select')][1];
        category.value = 'priority';
        category.dispatchEvent(new Event('change'));
        expect(target.querySelectorAll('.pc-conflict')).toHaveLength(0);
    });

    it('stages suppression from a conflict and shows the staging bar with counts', () => {
        const { target, mock } = mount({ state: { report: report() } });
        clickByText(target, '展开');
        const suppress = [...target.querySelectorAll('button')].find(button => button.textContent?.startsWith('暂存屏蔽'));
        suppress.click();
        expect(mock.stageSuppress).toHaveBeenCalledWith('wi:lore:1');
        mock.state.stagedChanges = new Map([['wi:lore:1', { sourceId: 'wi:lore:1', worldDigest: 'b'.repeat(64), uid: 1, contentDigest: 'd'.repeat(64), action: 'suppress', dynamic: false }]]);
        mock.notify();
        expect(target.textContent).toContain('待屏蔽 1 项 · 待恢复 0 项');
        clickByText(target, '放弃更改');
        expect(mock.clearStagedChanges).toHaveBeenCalledOnce();
    });

    it('opens the confirm dialog with grouped lists and commits after review', async () => {
        const { target, mock } = mount({
            state: {
                stagedChanges: new Map([
                    ['wi:lore:1', { sourceId: 'wi:lore:1', worldDigest: 'b'.repeat(64), uid: 1, contentDigest: 'd'.repeat(64), action: 'suppress', dynamic: false }],
                    ['wi:lore:2', { sourceId: 'wi:lore:2', worldDigest: 'b'.repeat(64), uid: 2, contentDigest: 'e'.repeat(64), action: 'restore', dynamic: false }],
                ]),
                snapshot: {
                    fingerprint: 'e'.repeat(64),
                    sources: [
                        worldSource(),
                        worldSource({ sourceId: 'wi:lore:2', uid: 2, suppressedForCurrentChat: true, enabledForDetection: false }),
                    ],
                },
                selectedSourceIds: new Set(),
            },
        });
        clickByText(target, '检查并应用');
        await vi.waitFor(() => expect(mock.beginApplyReview).toHaveBeenCalledOnce());
        const dialog = document.querySelector('.pc-dialog');
        await vi.waitFor(() => expect(dialog.open).toBe(true));
        expect(dialog.textContent).toContain('待屏蔽（1 项）');
        expect(dialog.textContent).toContain('待恢复（1 项）');
        clickByText(dialog, '应用');
        await vi.waitFor(() => expect(mock.commitStagedChanges).toHaveBeenCalledOnce());
    });

    it('warns about dynamic template entries in the dialog', async () => {
        const { target } = mount({
            state: {
                stagedChanges: new Map([
                    ['wi:lore:1', { sourceId: 'wi:lore:1', worldDigest: 'b'.repeat(64), uid: 1, contentDigest: 'd'.repeat(64), action: 'suppress', dynamic: true }],
                ]),
                snapshot: { fingerprint: 'e'.repeat(64), sources: [worldSource()] },
                selectedSourceIds: new Set(),
            },
        });
        clickByText(target, '检查并应用');
        const dialog = document.querySelector('.pc-dialog');
        await vi.waitFor(() => expect(dialog.open).toBe(true));
        expect(dialog.textContent).toContain('禁用整个条目');
    });

    it('shows progress and a cancel button while detecting', () => {
        const { target, mock } = mount({
            state: { phase: 'detecting', activeRun: { runId: 'r1', stage: 'extracting', done: 1, total: 3 } },
        });
        expect(target.textContent).toContain('正在提取 1/3 批');
        clickByText(target, '取消');
        expect(mock.cancelRun).toHaveBeenCalledOnce();
    });
});

describe('prompt conflict page states', () => {
    it('surfaces damaged metadata with a reset action', () => {
        const { target, mock } = mount({ state: { metadataError: '版本不受支持' } });
        expect(target.textContent).toContain('重置本聊天数据');
        clickByText(target, '重置本聊天数据');
        expect(mock.resetChatMetadata).toHaveBeenCalledOnce();
    });

    it('disables start detection without selected sources', () => {
        const { target } = mount({ state: { selectedSourceIds: new Set() } });
        const start = [...target.querySelectorAll('button')].find(button => button.textContent === '开始检测');
        expect(start.disabled).toBe(true);
    });

    it('cleans up the dialog when unmounted', () => {
        const { dispose } = mount();
        dispose();
        expect(document.querySelector('.pc-dialog')).toBeNull();
    });
});
