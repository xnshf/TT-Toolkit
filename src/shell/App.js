import { actionButton, bindScrollFade, h } from '../ui/dom.js';
import { confirmDanger } from '../ui/confirm.js';

function taxonomy(features) {
    const categories = new Map();
    for (const feature of features) {
        const category = categories.get(feature.category.id) ?? {
            id: feature.category.id,
            label: feature.category.label,
            order: feature.category.order,
            features: [],
        };
        category.features.push(feature);
        categories.set(category.id, category);
    }
    return [...categories.values()]
        .sort((a, b) => a.order - b.order)
        .map(category => ({
            ...category,
            features: category.features.sort((a, b) => a.order - b.order),
        }));
}

export class ToolkitApp {
    route;
    renderToken = 0;
    disposeFeature = null;
    updateCategoryFade = null;
    updateFeatureFade = null;
    // 当前功能自己注册的草稿检查函数；为空表示离开无需询问。
    leaveGuard = null;
    // 询问进行中的 Promise：连点 ✕ 或按住 Esc 只会弹出一个对话框。
    leaveRequest = null;

    constructor(target, props) {
        this.target = target;
        this.props = props;
        this.route = props.features.some(feature => feature.id === props.initialRoute)
            ? props.initialRoute
            : 'overview';
    }

    mount() {
        this.sizeButton = actionButton('◇', this.props.cycleSize, { className: 'resize-button', title: '切换尺寸档位', ariaLabel: '切换尺寸档位' });
        this.layoutWarningText = h('span');
        this.layoutWarning = h('div', { className: 'layout-warning callout warning', attrs: { role: 'status', hidden: true } },
            this.layoutWarningText,
            actionButton('重试保存布局', this.props.retryLayoutSave, { className: 'secondary' }),
        );
        this.resizeHandle = h('button', {
            type: 'button', className: 'workbench-resize-handle', text: '◢',
            attrs: { 'data-resize-handle': '', 'aria-label': '调整窗口大小' },
            title: '拖动右下角调整窗口大小，或用方向键调整',
        });
        this.resizeBar = h('div', { className: 'workbench-resize-bar', attrs: { hidden: true } }, this.resizeHandle);
        const titlebar = h('header', { className: 'workbench-titlebar', attrs: { 'data-drag-handle': '' } },
            h('div', {}, h('b', { text: 'TT-Toolkit' }), h('span', { className: 'workbench-version', text: this.props.version })),
            h('div', { className: 'title-actions' },
                this.sizeButton,
                actionButton('↺', this.props.resetLayout, { className: 'reset-layout', title: '重置界面布局', ariaLabel: '重置界面布局' }),
                actionButton('×', this.props.close, { className: 'close-button', attrs: { 'aria-label': '关闭工作台' } }),
            ),
        );
        this.categoryNavigation = h('nav', { className: 'category-navigation', attrs: { 'aria-label': '功能大类' } });
        this.featureNavigation = h('nav', { className: 'feature-navigation', attrs: { 'aria-label': '当前大类功能' } });
        this.main = h('main');
        this.workbench = h('div', { className: 'workbench' },
            titlebar,
            this.layoutWarning,
            h('div', { className: 'workbench-body' },
                this.categoryNavigation,
                this.featureNavigation,
                this.main,
            ),
            this.resizeBar,
        );
        this.target.replaceChildren(this.workbench);
        this.updateCategoryFade = bindScrollFade(this.categoryNavigation);
        this.updateFeatureFade = bindScrollFade(this.featureNavigation);
        this.renderNavigation();
        void this.renderMain();
        this.bindFrameDismiss();
        return this;
    }

    updateLayout({ mobile, fullscreen }) {
        this.resizeBar.hidden = !mobile || fullscreen;
        this.resizeHandle.disabled = !mobile || fullscreen;
        const label = mobile ? (fullscreen ? '切换为悬浮窗口' : '切换为全屏') : '切换尺寸档位';
        this.sizeButton.textContent = mobile ? (fullscreen ? '悬浮' : '全屏') : '◇';
        this.sizeButton.title = label;
        this.sizeButton.setAttribute('aria-label', label);
    }

    setLayoutWarning(message) {
        this.layoutWarningText.textContent = message;
        this.layoutWarning.hidden = !message;
    }

    // 是否有功能注册了草稿检查。外壳据此走同步快路径：无草稿时关闭与切换保持同步生效。
    hasLeaveGuard() {
        return typeof this.leaveGuard === 'function';
    }

    // 离开当前功能前的唯一询问入口：关闭工作台与切换功能都走这里。
    // 询问在 iframe 内进行；返回 false 表示用户选择留在当前页面。
    async requestLeave() {
        if (this.leaveRequest)
            return this.leaveRequest;
        const guard = this.leaveGuard;
        if (!guard)
            return true;
        this.leaveRequest = (async () => {
            try {
                return await guard() === true;
            }
            catch {
                // 守卫自身异常时不能把用户锁死在工作台里：改用一次明确的兜底确认。
                return confirmDanger(this.target.ownerDocument, {
                    title: '未保存状态无法确认',
                    message: '检查未保存修改时出错。继续离开可能丢弃当前改动。',
                    confirmLabel: '仍然离开',
                });
            }
            finally {
                this.leaveRequest = null;
            }
        })();
        return this.leaveRequest;
    }

    // 窗口四周露出遮罩:点击工作台外或按 Esc 关闭;确认框打开时 Esc 交给 dialog。
    bindFrameDismiss() {
        const doc = this.target.ownerDocument;
        this.onKeyDown = event => {
            if (event.key !== 'Escape' || doc.querySelector('dialog[open]'))
                return;
            this.props.close();
        };
        this.onClickOutside = event => {
            if (event.target === this.target)
                this.props.close();
        };
        doc.addEventListener('keydown', this.onKeyDown);
        this.target.addEventListener('click', this.onClickOutside);
    }

    async navigate(route) {
        // 同一路由不重复询问与重绘。
        if (route === this.route)
            return;
        // 被用户拒绝时保持当前路由与 DOM 原样，草稿不被丢弃。
        if (!await this.requestLeave())
            return;
        this.leaveGuard = null;
        this.route = route;
        this.renderNavigation();
        const persistRoute = this.props.setRoute(route);
        await this.renderMain();
        await persistRoute;
    }

    renderNavigation() {
        const categories = taxonomy(this.props.features);
        const activeFeature = this.props.features.find(feature => feature.id === this.route);
        const activeCategory = activeFeature
            ? categories.find(category => category.id === activeFeature.category.id)
            : null;
        this.workbench.classList.toggle('has-feature-navigation', Boolean(activeCategory));

        const overview = actionButton('总览', () => { void this.navigate('overview'); }, {
            className: this.route === 'overview' ? 'overview-link active' : 'overview-link',
            dataset: { route: 'overview' },
            attrs: this.route === 'overview' ? { 'aria-current': 'page' } : {},
        });
        const categoryButtons = categories.map(category => {
            const active = activeCategory?.id === category.id;
            return actionButton(category.label, () => { void this.navigate(category.features[0].id); }, {
                className: active ? 'active' : '',
                dataset: { categoryId: category.id },
                attrs: active ? { 'aria-current': 'page' } : {},
            });
        });
        this.categoryNavigation.replaceChildren(overview, ...categoryButtons);

        const featureButtons = (activeCategory?.features ?? []).map(feature => {
            const active = this.route === feature.id;
            const button = actionButton('', () => { void this.navigate(feature.id); }, {
                className: active ? 'active' : '',
                dataset: { featureId: feature.id },
                attrs: active ? { 'aria-current': 'page' } : {},
            });
            button.replaceChildren(
                h('span', { text: `${feature.icon} ${feature.label}` }),
                ...(this.props.enabled[feature.id] ? [] : [h('i', { text: '未启用' })]),
            );
            return button;
        });
        this.featureNavigation.hidden = !activeCategory;
        this.featureNavigation.replaceChildren(
            ...(activeCategory ? [h('h2', { text: '功能' })] : []),
            ...featureButtons,
        );
        this.updateCategoryFade?.();
        this.updateFeatureFade?.();
    }

    async renderMain() {
        const token = ++this.renderToken;
        // 守卫属于“当前已挂载的功能”，换页时先清除，避免上一个功能的旧检查被复用。
        this.leaveGuard = null;
        this.disposeFeature?.();
        this.disposeFeature = null;
        if (this.route === 'overview') {
            const categorySections = taxonomy(this.props.features).map(category => h('section', { className: 'overview-category' },
                h('h2', { text: category.label }),
                h('div', { className: 'feature-cards' }, category.features.map(feature => {
                    const card = actionButton('', () => { void this.navigate(feature.id); }, {
                        dataset: { overviewFeatureId: feature.id },
                    });
                    card.append(
                        h('span', { className: 'card-icon', text: feature.icon }),
                        h('b', { text: feature.label }),
                        h('small', { text: feature.description }),
                        h('i', { text: this.props.enabled[feature.id] ? '已启用' : '未启用' }),
                    );
                    return card;
                })),
            ));
            this.main.replaceChildren(h('section', { className: 'overview' },
                h('p', { className: 'eyebrow', text: 'TAURITAVERN EXCLUSIVE' }),
                h('h1', { text: '工具总览' }),
                h('p', { text: '按数据类型管理独立的 TauriTavern 优化功能。' }),
                ...categorySections,
            ));
            return;
        }
        const feature = this.props.features.find(item => item.id === this.route);
        if (!feature) {
            this.main.replaceChildren();
            return;
        }
        this.main.replaceChildren(h('div', { className: 'callout', text: '正在加载功能……' }));
        try {
            const dispose = await feature.mount(this.main, {
                enabled: Boolean(this.props.enabled[feature.id]),
                closeWorkbench: this.props.close,
                entrySettings: this.props.entrySettings,
                themeSettings: this.props.themeSettings,
                // 功能页据此注册自己的草稿检查；晚于本次渲染的注册直接丢弃。
                setLeaveGuard: guard => {
                    if (token === this.renderToken)
                        this.leaveGuard = typeof guard === 'function' ? guard : null;
                },
                setEnabled: async value => {
                    await this.props.setFeatureEnabled(feature.id, value);
                    this.renderNavigation();
                },
            });
            if (token !== this.renderToken) {
                dispose?.();
                return;
            }
            this.disposeFeature = dispose ?? null;
        }
        catch (error) {
            if (token === this.renderToken)
                this.main.replaceChildren(h('div', { className: 'callout danger', text: '功能加载失败，请关闭工作台后重试。' }));
            throw error;
        }
    }

    unmount() {
        this.renderToken += 1;
        this.leaveGuard = null;
        this.leaveRequest = null;
        this.disposeFeature?.();
        const doc = this.target.ownerDocument;
        doc.removeEventListener('keydown', this.onKeyDown);
        this.target.removeEventListener('click', this.onClickOutside);
        this.target.replaceChildren();
    }
}
