// Shared by the renderer and Node. Limits count Unicode code points, never UTF-16 halves.
export const PROMPT_LIMITS = Object.freeze({ codePoints: 100000, utf8Bytes: 400000 });
export const DRAFT_LIMITS = Object.freeze({ codePoints: 200000, utf8Bytes: 800000 });
export const SUMMARY_LIMIT = 8000;
export const CONTEXT_LIMIT = 12000;
const encoder = new TextEncoder();
export function promptStats(value) {
  return { codePoints: Array.from(value).length, utf8Bytes: encoder.encode(value).byteLength };
}
export function promptProblem(value, { allowEmpty = false, limits = PROMPT_LIMITS } = {}) {
  if (typeof value !== 'string') return '任务原文必须是文字';
  if (!allowEmpty && !value.trim()) return '任务原文不能为空';
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return '任务原文含无效 Unicode 字符，请修正后发送';
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return '任务原文含无效 Unicode 字符，请修正后发送';
  }
  const size = promptStats(value);
  if (size.codePoints > limits.codePoints || size.utf8Bytes > limits.utf8Bytes)
    return `任务原文超过 ${limits.codePoints.toLocaleString('en-US')} 码点 / ${limits.utf8Bytes.toLocaleString('en-US')} UTF-8 字节上限（当前 ${size.codePoints.toLocaleString('en-US')} 码点、${size.utf8Bytes.toLocaleString('en-US')} 字节）；不会截断发送`;
  return '';
}
export function validatePrompt(value, options) {
  const error = promptProblem(value, options);
  if (error) throw Error(error);
  return value; // Deliberately preserve leading/trailing whitespace and exact user text.
}
export function summarizePrompt(value, limit = SUMMARY_LIMIT) {
  const points = Array.from(value || ''), size = promptStats(value || '');
  const truncated = points.length > limit;
  const text = points.slice(0, limit).join('');
  return { kind: 'coordination-summary', ...size, limit, truncated, text,
    display: `${truncated ? '【协调摘要：已截断' : '【协调摘要'}；${Math.min(points.length, limit)}/${points.length} 码点；非任务原文】\n${text}` };
}
export function providerPrompt(session, memories, original) {
  validatePrompt(original);
  const context = `共享任务：${session.title}\n计划：${(session.plan || []).map(p => `${p.done ? '[x]' : '[ ]'} ${p.text}`).join('\n')}\n团队记忆：${(memories || []).map(m => `${m.stale ? '【已过期：核对或更新前不可当作现行事实】' : ''}${m.title}: ${m.text}`).join('\n')}\n协作记录：\n${(session.lanes || []).flatMap(l => (l.entries || []).filter(e => ['user', 'assistant'].includes(e.role)).slice(-12).map(e => `[${l.owner}] ${e.text}`)).join('\n')}`;
  return `${summarizePrompt(context, CONTEXT_LIMIT).display}\n\n当前用户要求（完整原文，${promptStats(original).codePoints} 码点）：\n${original}`;
}
