export function h(tag, properties = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(properties)) {
        if (value === undefined || value === null || value === false)
            continue;
        if (key === 'className')
            node.className = value;
        else if (key === 'text')
            node.textContent = value;
        else if (key === 'dataset')
            Object.assign(node.dataset, value);
        else if (key === 'attrs')
            for (const [name, attribute] of Object.entries(value))
                node.setAttribute(name, String(attribute));
        else if (key === 'on')
            for (const [event, listener] of Object.entries(value))
                node.addEventListener(event, listener);
        else if (key in node)
            node[key] = value;
        else
            node.setAttribute(key, String(value));
    }
    const append = child => {
        if (Array.isArray(child))
            child.forEach(append);
        else if (child instanceof Node)
            node.append(child);
        else if (child !== undefined && child !== null && child !== false)
            node.append(document.createTextNode(String(child)));
    };
    children.forEach(append);
    return node;
}

export function actionButton(text, onClick, options = {}) {
    return h('button', { type: 'button', text, on: { click: onClick }, ...options });
}

// 横向滚动容器两端的渐隐提示:滚动未到端点时对应侧出现渐隐。
// 返回 update 以便内容替换(如导航重渲染)后重新判定,窗口尺寸变化由 ResizeObserver 覆盖。
export function bindScrollFade(element) {
    const update = () => {
        const max = element.scrollWidth - element.clientWidth;
        element.classList.toggle('fade-left', element.scrollLeft > 1);
        element.classList.toggle('fade-right', element.scrollLeft < max - 1);
    };
    element.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return update;
}

export function callout(text, kind = '') {
    return h('div', { className: `callout${kind ? ` ${kind}` : ''}`, text });
}
