import {useAppearance, avatarColors} from "./Appearance";
import type { ReactNode } from "react";
import { X, Aperture } from "lucide-react";
export type Call = (
  method: string,
  args?: Record<string, unknown>,
) => Promise<any>;
export const statusNames: Record<string, string> = {
  idle: "待命",
  running: "执行中",
  awaiting: "待审批",
  done: "已完成",
  error: "失败",
  interrupted: "已中断",
  needs_handoff: "待接管",
};
export const time = (s: string) =>
  new Date(s).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
export function Mark() {
  return <Aperture className="brand-mark" />;
}
export function Avatar({
  name,
  small = false,
}: {
  name: string;
  small?: boolean;
}) {
  const appearance=useAppearance();
  return (
    <span style={avatarColors(name,appearance)} className={"avatar " + (small ? "small" : "")} title={name}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
export function Empty({
  icon: Icon,
  title,
  text,
}: {
  icon: any;
  title: string;
  text?: string;
}) {
  return (
    <div className="empty">
      <Icon size={24} />
      <span>{title}</span>
      {text && <small>{text}</small>}
    </div>
  );
}
export function Modal({
  title,
  close,
  children,
  drawer = false,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  drawer?: boolean;
}) {
  return (
    <div
      className={"modal-backdrop " + (drawer ? "drawer-backdrop" : "")}
      onClick={close}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={"modal " + (drawer ? "share-drawer" : "")}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-heading">
          <strong>{title}</strong>
          <button
            className="icon-button"
            aria-label="关闭"
            title="关闭"
            onClick={close}
          >
            <X size={16} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </section>
    </div>
  );
}
