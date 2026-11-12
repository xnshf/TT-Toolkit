import { LINE_LIMIT, lineBudgetWarnings, readLineCounts } from './line-budget.mjs';

const entries = readLineCounts();
const warnings = lineBudgetWarnings(entries);
for (const warning of warnings) process.stdout.write(`warning: ${warning}\n`);
if (warnings.length === 0) process.stdout.write(`单文件行数预算通过（上限 ${LINE_LIMIT} 行，${entries.length} 个文件）。\n`);
