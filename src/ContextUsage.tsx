import type { LaneUsage } from "./types";
const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const count = (value: number | null) =>
  value === null ? "未提供" : value.toLocaleString();
export function ContextUsage({ usage }: { usage?: LaneUsage }) {
  if (!usage) return null;
  const { usedTokens: used, limitTokens: limit, basis } = usage.context;
  const ratio =
    used !== null && limit !== null && limit > 0 ? used / limit : null;
  const label =
    ratio !== null
      ? `${Math.round(ratio * 100)}%`
      : used !== null
        ? `${compact.format(used)} tokens`
        : "用量";
  const title = basis === "provider-context" ? "当前上下文" : "最近请求输入";
  const total = usage.cumulative;
  return (
    <details className="context-usage">
      <summary
        aria-label="查看上下文用量"
        title={`${title}：${count(used)} / ${count(limit)} tokens`}
      >
        <span
          className={"context-usage-dot" + (ratio === null ? " unknown" : "")}
          style={
            {
              "--usage": `${Math.min(100, Math.max(0, (ratio ?? 0) * 100))}%`,
            } as React.CSSProperties
          }
        />
        {label}
      </summary>
      <div className="context-usage-popover">
        <strong>{title}</strong>
        <dl>
          <dt>已用</dt>
          <dd>{count(used)} tokens</dd>
          <dt>上限</dt>
          <dd>
            {limit === null ? "Provider 未提供" : `${count(limit)} tokens`}
          </dd>
        </dl>
        {total && (
          <>
            <strong>
              {
                {
                  "provider-session": "会话累计",
                  run: "本次执行",
                  turn: "本轮",
                }[total.scope]
              }
            </strong>
            <dl>
              <dt>输入</dt>
              <dd>{count(total.inputTokens)}</dd>
              <dt>输出</dt>
              <dd>{count(total.outputTokens)}</dd>
              {total.cachedInputTokens !== null && (
                <>
                  <dt>缓存输入</dt>
                  <dd>{count(total.cachedInputTokens)}</dd>
                </>
              )}
            </dl>
          </>
        )}
        {usage.cost && (
          <small>
            {usage.cost.kind === "estimate" ? "估算费用" : "Provider 报告费用"}{" "}
            · {usage.cost.currency}{" "}
            {usage.cost.amount.toLocaleString(undefined, {
              maximumFractionDigits: 6,
            })}
          </small>
        )}
        <small>
          来自 Provider · {new Date(usage.updatedAt).toLocaleTimeString()}
        </small>
      </div>
    </details>
  );
}
