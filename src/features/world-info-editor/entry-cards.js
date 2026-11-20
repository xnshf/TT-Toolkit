import { actionButton, h } from '../../ui/dom.js';
import { confirmDanger } from '../../ui/confirm.js';
import { estimateTokens, POSITION_OPTIONS } from './schema.js';

// 左侧条目卡片列表。结构异常的条目只禁用这一行的编辑，整本世界书仍可浏览。
export function createEntryCards({ runtime, view, target, runNavigating }) {
    function renderCards(list) {
        const entries = runtime.getFilteredEntries();
        list.replaceChildren(...(entries.length
            ? entries.map(entry => renderEntryCard(entry))
            : [h('div', { className: 'wie-empty-hint', text: '未找到匹配的条目。' })]));
    }

    function renderBrokenEntryCard(entry) {
        const removeBtn = actionButton('删除', () => {
            void runNavigating(async () => {
                const confirmedTarget = {
                    world: runtime.state.selectedWorld,
                    value: runtime.state.worldData?.entries?.[entry.uid],
                };
                const confirmed = await confirmDanger(target.ownerDocument, {
                    title: `确认删除结构异常的条目 #${entry.uid}`,
                    message: '只会从世界书文件中移除这一条。删除无法撤销，如需保留原数据，请先自行备份世界书。',
                    confirmLabel: '删除条目',
                });
                if (confirmed)
                    await runtime.deleteEntry(entry.uid, { confirmedTarget });
            });
        }, { className: 'danger-button' });
        return h('article', { className: 'wie-card wie-card-broken', dataset: { uid: String(entry.uid) } },
            h('div', { className: 'wie-card-head' },
                h('div', { className: 'wie-card-title-group' },
                    h('span', { className: 'wie-card-uid', text: `#${entry.uid}` }),
                    h('strong', { className: 'wie-card-title', text: entry.comment }),
                ),
                removeBtn,
            ),
            h('div', { className: 'wie-card-keys' },
                h('span', { className: 'wie-tag', text: '结构异常，无法在编辑器中修改' }),
            ),
        );
    }

    function renderEntryCard(entry) {
        const state = runtime.state;
        if (entry.broken)
            return renderBrokenEntryCard(entry);
        const isSelected = state.selectedUid === entry.uid;
        const isDisabled = entry.disable;

        const card = h('article', {
            className: `wie-card${isSelected ? ' active' : ''}${isDisabled ? ' disabled' : ''}`,
            dataset: { uid: String(entry.uid) },
        });

        // 迷你内联开关
        const switchInput = h('input', { type: 'checkbox', checked: !isDisabled, attrs: { 'aria-label': `启用条目 #${entry.uid}` } });
        switchInput.addEventListener('change', event => {
            event.stopPropagation();
            void runNavigating(async () => {
                await runtime.toggleEntryActive(entry.uid, switchInput.checked);
            });
        });
        const miniSwitch = h('label', { className: 'wie-mini-switch' },
            switchInput,
            h('span', { className: 'wie-mini-slider' }),
        );
        miniSwitch.addEventListener('click', e => e.stopPropagation());

        const head = h('div', { className: 'wie-card-head' },
            h('div', { className: 'wie-card-title-group' },
                h('span', { className: 'wie-card-uid', text: `#${entry.uid}` }),
                h('strong', { className: 'wie-card-title', text: entry.comment || '(未命名条目)' }),
            ),
            miniSwitch,
        );

        // 关键词预览
        const keysContainer = h('div', { className: 'wie-card-keys' });
        const primaryPreview = (entry.key || []).slice(0, 3);
        for (const k of primaryPreview) {
            keysContainer.append(h('span', { className: 'wie-tag', text: String(k) }));
        }
        if (entry.key && entry.key.length > 3) {
            keysContainer.append(h('span', { className: 'wie-tag', text: `+${entry.key.length - 3}` }));
        }
        if (entry.selective && entry.keysecondary && entry.keysecondary.length > 0) {
            keysContainer.append(h('span', { className: 'wie-tag secondary', text: `& ${entry.keysecondary[0]}` }));
        }

        // 底部徽章
        const badges = h('div', { className: 'wie-badges' });
        if (entry.hasImage) {
            badges.append(h('span', { className: 'wie-badge wie-badge-image', text: '图片' }));
        }
        else if (entry.imageInvalid) {
            badges.append(h('span', { className: 'wie-badge wie-badge-disabled', text: '图片异常' }));
        }
        if (entry.constant) {
            badges.append(h('span', { className: 'wie-badge wie-badge-constant', text: '常驻' }));
        }
        if (entry.position === 4) {
            badges.append(h('span', { className: 'wie-badge wie-badge-depth', text: `@D ${entry.depth ?? 4}` }));
        }
        else {
            const posOption = POSITION_OPTIONS.find(p => p.value === entry.position);
            badges.append(h('span', { className: 'wie-badge wie-badge-pos', text: posOption?.label?.split(' ')[0] ?? '位置' }));
        }
        if (isDisabled) {
            badges.append(h('span', { className: 'wie-badge wie-badge-disabled', text: '禁用' }));
        }

        const foot = h('div', { className: 'wie-card-foot' },
            badges,
            h('span', { text: `~${estimateTokens(entry.content)} T` }),
        );

        card.append(head, keysContainer, foot);
        card.addEventListener('click', () => {
            void runNavigating(async () => {
                await runtime.selectEntry(entry.uid);
                view.mobileSubView = 'edit';
            });
        });

        return card;
    }

    return { renderCards };
}
