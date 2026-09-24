import type { Lane, ModelConfiguration } from "./types";
import "./model-sharing.css";

const label = (configuration?: ModelConfiguration, missing = "未设置") => configuration?.model || missing;
const detail = (configuration?: ModelConfiguration, missing = "未设置") => `${label(configuration, missing)} · 推理 ${configuration?.effort || missing}`;

export function LaneModel({ lane }: { lane: Lane }) {
  const run = lane.runConfiguration?.runId === lane.activeRunId ? lane.runConfiguration : undefined;
  const running = lane.status === "running";
  const current = run?.reported?.model ? run.reported : run?.requested;
  const shown = running ? label(current, "未报告") : label(lane.configuration);
  const title = [
    `下次选择：${detail(lane.configuration)}`,
    ...(run ? [`${running ? "本轮" : "上轮"}发送：${detail(run.requested)}`, `Provider 确认：${detail(run.reported, "未报告")}`] : []),
  ].join("\n");
  return <span className="lane-model" title={title}>{shown}</span>;
}
