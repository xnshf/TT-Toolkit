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

export function callout(text, kind = '') {
    return h('div', { className: `callout${kind ? ` ${kind}` : ''}`, text });
}
