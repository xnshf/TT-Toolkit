import { h } from '../../ui/dom.js';
import { isRegexKey } from './schema.js';

// 触发词编辑器：输入框常驻，仅在增删词条时重建词条块本身，移动端键盘不会闪退。
export function createTagEditor({ runtime, tagRefs, scheduleScroll }) {
    return function renderTagEditor(slot, tags, mutate, revision, isSecondary = false) {
        const box = h('div', { className: 'wie-tag-box' });
        const tagList = h('div', { className: 'wie-tag-list' });
        const input = h('input', {
            type: 'text',
            className: 'wie-tag-input',
            placeholder: tags.length === 0 ? '键入词按回车或逗号添加…' : '+ 添加…',
            attrs: { 'aria-label': isSecondary ? '添加二级过滤词' : '添加主要触发词' },
        });
        const ref = { refresh: null };

        function commit(value) {
            const val = value.trim().replace(/^,+|[,，]+$/g, '');
            if (!val)
                return false;
            const next = [...ref.tags, val];
            mutate(next);
            // 在重建前对齐 revision：本次变更不是“外部改动”，无需重新播种。
            ref.revision = runtime.revision;
            ref.tags = next;
            ref.render();
            return true;
        }

        // 在标签之外处理刷新：输入框不重建，移动端键盘不会闪退。
        ref.refresh = (nextTags, nextRevision) => {
            ref.revision = nextRevision;
            if (JSON.stringify(nextTags ?? []) === JSON.stringify(ref.tags)) {
                ref.render();
                return;
            }
            ref.tags = [...(nextTags ?? [])];
            ref.render();
        };

        ref.render = () => {
            input.placeholder = ref.tags.length === 0 ? '键入词按回车或逗号添加…' : '+ 添加…';
            tagList.replaceChildren(...ref.tags.map((tag, idx) => {
                const isReg = isRegexKey(tag);
                const tagEl = h('span', { className: `wie-tag${isSecondary ? ' secondary' : ''}${isReg ? ' regex' : ''}` },
                    h('span', { text: tag }),
                    isReg ? h('span', { className: 'wie-tag-regex-badge', text: 'REG' }) : null,
                );
                const removeBtn = h('button', {
                    type: 'button',
                    className: 'wie-tag-remove',
                    text: '×',
                    attrs: { 'aria-label': `删除触发词 ${tag}` },
                });
                removeBtn.addEventListener('click', event => {
                    event.stopPropagation();
                    const next = [...ref.tags];
                    next.splice(idx, 1);
                    mutate(next);
                    ref.revision = runtime.revision;
                    ref.tags = next;
                    ref.render();
                });
                tagEl.append(removeBtn);
                return tagEl;
            }));
        };

        input.addEventListener('keydown', event => {
            if (event.isComposing || event.keyCode === 229) return;
            if (event.key === ',' && input.value.startsWith('/') && !isRegexKey(input.value)) return;
            if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
                event.preventDefault();
                if (commit(input.value))
                    input.value = '';
            }
        });

        // 没有键盘上的逗号/回车可用时（手机输入法），失焦即成块，避免输入被静默丢弃。
        input.addEventListener('blur', () => {
            if (!input.value.trim())
                return;
            if (commit(input.value))
                input.value = '';
        });

        input.addEventListener('focus', () => {
            scheduleScroll(input);
        });

        box.append(tagList, input);
        ref.tags = [...(tags ?? [])];
        ref.revision = revision;
        ref.render();
        tagRefs[slot] = ref;
        return box;
    };
}
