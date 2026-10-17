// 宿主世界书读写经过 Rust serde_json（未启用 preserve_order），对象键会被重排为字典序，
// 客户端自己构造的对象则保留 JS 插入顺序。因此“快照是否未变”必须与键序无关，
// 否则新增条目、给条目新增字段之后的下一次保存都会被误判成外部改动。
// 数组顺序仍然有意义，保持严格比较。
export function sameJsonValue(left, right) {
    return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value) {
    if (value === undefined)
        return 'undefined';
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        const parts = Object.keys(value)
            .filter(key => value[key] !== undefined)
            .sort()
            .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
        return `{${parts.join(',')}}`;
    }
    return JSON.stringify(value) ?? 'undefined';
}
