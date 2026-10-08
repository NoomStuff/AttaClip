import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Check, ChevronDown, LoaderCircle, X } from "lucide-react";

export const api = window.attaClip;
export const formatSize = (bytes: number): string => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`);
export const formatTime = (seconds: number): string => {
   const whole = Math.max(0, Math.floor(seconds));
   return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};
export const folderName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? "Choose a folder";
export const age = (timestamp: number): string => {
   const minutes = Math.max(0, (Date.now() - timestamp) / 60000);
   if (minutes < 1) return "Just now";
   if (minutes < 60) return `${Math.floor(minutes)}m ago`;
   if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
   return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};
export type Run = (action: () => Promise<unknown>) => Promise<boolean>;
export function describeError(error: unknown): string {
   const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Something went wrong. Please try again.";
   return message.replace(/^Error invoking remote method '[^']+':\s*/, "").replace(/^Error:\s*/, "");
}

export function Button({ children, className = "", busy = false, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
   return (
      <button {...props} disabled={props.disabled || busy} className={`button ${className}`}>
         {busy && <LoaderCircle size={16} className="spin" />}
         {children}
      </button>
   );
}
export function IconButton({ children, label, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
   return (
      <button {...props} title={label} aria-label={label} className={`icon-button ${className}`}>
         {children}
      </button>
   );
}
export function Segmented<T extends string>({
   value,
   values,
   onChange,
   label,
}: {
   value: T;
   values: { value: T; label: string }[];
   onChange: (value: T) => void;
   label: string;
}) {
   return (
      <div className="segmented" role="group" aria-label={label}>
         {values.map((item) => (
            <button
               key={item.value}
               className={value === item.value ? "selected" : ""}
               aria-pressed={value === item.value}
               onClick={() => onChange(item.value)}
            >
               {item.label}
            </button>
         ))}
      </div>
   );
}
export function Toggle({
   checked,
   onChange,
   label,
   detail,
   disabled = false,
}: {
   checked: boolean;
   onChange: (value: boolean) => void;
   label: string;
   detail?: string;
   disabled?: boolean;
}) {
   return (
      <label className={`toggle-row ${disabled ? "disabled" : ""}`}>
         <span>
            <span className="field-label">{label}</span>
            {detail && <span className="field-detail">{detail}</span>}
         </span>
         <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} disabled={disabled} />
         <span className="switch" aria-hidden="true" />
      </label>
   );
}
export function Field({ label, detail, children }: { label: string; detail?: string; children: ReactNode }) {
   return (
      <div className="field">
         <div>
            <span className="field-label">{label}</span>
            {detail && <p className="field-detail">{detail}</p>}
         </div>
         <div className="field-control">{children}</div>
      </div>
   );
}
export function Empty({ icon, title, detail, children }: { icon: ReactNode; title: string; detail: string; children?: ReactNode }) {
   return (
      <div className="empty">
         <div className="empty-icon">{icon}</div>
         <h2>{title}</h2>
         <p>{detail}</p>
         {children}
      </div>
   );
}
export function Menu({ trigger, children, label }: { trigger: ReactNode; children: ReactNode; label: string }) {
   const [open, setOpen] = useState(false);
   const ref = useRef<HTMLDivElement>(null);
   const menu = useRef<HTMLDivElement>(null);
   const [position, setPosition] = useState({ top: 0, left: 0 });
   useLayoutEffect(() => {
      if (!open || !ref.current || !menu.current) return;
      const anchor = ref.current.getBoundingClientRect();
      const bounds = menu.current.getBoundingClientRect();
      setPosition({
         left: Math.max(8, Math.min(window.innerWidth - bounds.width - 8, anchor.right - bounds.width)),
         top: anchor.bottom + bounds.height + 8 > window.innerHeight ? Math.max(8, anchor.top - bounds.height - 5) : anchor.bottom + 5,
      });
      menu.current.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
   }, [open]);
   useEffect(() => {
      if (!open) return;
      const close = (event: PointerEvent) => {
         if (!ref.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false);
      };
      const key = (event: KeyboardEvent) => {
         if (event.key === "Escape") {
            setOpen(false);
            ref.current?.querySelector("button")?.focus();
         }
      };
      window.addEventListener("pointerdown", close);
      window.addEventListener("keydown", key);
      return () => {
         window.removeEventListener("pointerdown", close);
         window.removeEventListener("keydown", key);
      };
   }, [open]);
   return (
      <div className="menu-wrap" ref={ref}>
         <IconButton
            label={label}
            aria-expanded={open}
            aria-haspopup="menu"
            onClick={() => setOpen(!open)}
            onKeyDown={(event) => {
               if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setOpen(true);
               }
            }}
         >
            {trigger}
         </IconButton>
         {open &&
            createPortal(
               <div
                  ref={menu}
                  className="menu floating-menu"
                  style={position}
                  role="menu"
                  onClick={() => setOpen(false)}
                  onKeyDown={(event) => {
                     if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                     event.preventDefault();
                     const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
                     const index = items.indexOf(document.activeElement as HTMLButtonElement);
                     const next =
                        event.key === "Home"
                           ? 0
                           : event.key === "End"
                             ? items.length - 1
                             : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
                     items[next]?.focus();
                  }}
               >
                  {children}
               </div>,
               document.body
            )}
      </div>
   );
}
export function MenuItem({
   children,
   onClick,
   danger = false,
   disabled = false,
}: {
   children: ReactNode;
   onClick: () => void;
   danger?: boolean;
   disabled?: boolean;
}) {
   return (
      <button role="menuitem" className={danger ? "danger" : ""} onClick={onClick} disabled={disabled}>
         {children}
      </button>
   );
}
export function Select({
   value,
   onChange,
   label,
   children,
   disabled = false,
}: {
   value: string;
   onChange: (value: string) => void;
   label: string;
   children: ReactNode;
   disabled?: boolean;
}) {
   return (
      <div className="select-wrap">
         <select value={value} onChange={(event) => onChange(event.target.value)} aria-label={label} disabled={disabled}>
            {children}
         </select>
         <ChevronDown size={14} />
      </div>
   );
}
export function LevelSlider({ value, label, disabled, onCommit }: { value: number; label: string; disabled: boolean; onCommit: (value: number) => void }) {
   const [display, setDisplay] = useState(value);
   const timer = useRef<number | undefined>(undefined);
   const committing = useRef(false);
   const callback = useRef(onCommit);
   callback.current = onCommit;
   useEffect(() => {
      if (!committing.current) setDisplay(value);
   }, [value]);
   useEffect(
      () => () => {
         if (timer.current) window.clearTimeout(timer.current);
      },
      []
   );
   const commit = (next: number) => {
      if (timer.current) window.clearTimeout(timer.current);
      committing.current = false;
      callback.current(next);
   };
   const update = (next: number) => {
      setDisplay(next);
      committing.current = true;
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => commit(next), 300);
   };
   return (
      <div className="level-slider">
         <input
            type="range"
            aria-label={label}
            min={0}
            max={2}
            step={0.01}
            disabled={disabled}
            value={display}
            onChange={(event) => update(Number(event.target.value))}
            onPointerUp={() => {
               if (committing.current) commit(display);
            }}
            onKeyUp={() => {
               if (committing.current) commit(display);
            }}
         />
         <span className="tabular">{display <= 0 ? "−∞" : `${20 * Math.log10(display) >= 0 ? "+" : ""}${(20 * Math.log10(display)).toFixed(1)}`} dB</span>
      </div>
   );
}
export interface DialogRequest {
   title: string;
   detail: string;
   confirm: string;
   initial?: string;
   danger?: boolean;
   resolve: (value: string | boolean | null) => void;
}
export function Dialog({ request, close }: { request: DialogRequest; close: () => void }) {
   const [value, setValue] = useState(request.initial ?? "");
   const input = useRef<HTMLInputElement>(null);
   const card = useRef<HTMLDivElement>(null);
   const cancel = () => {
      request.resolve(null);
      close();
   };
   const submit = () => {
      request.resolve(request.initial === undefined ? true : value.trim());
      close();
   };
   useEffect(() => {
      input.current?.focus();
      if (!input.current) card.current?.querySelector<HTMLButtonElement>("button")?.focus();
   }, []);
   return (
      <div className="modal-backdrop" onClick={cancel}>
         <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
            ref={card}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
               if (event.key === "Escape") cancel();
               if (event.key === "Tab") {
                  const nodes = card.current?.querySelectorAll<HTMLElement>("button,input");
                  const first = nodes?.[0];
                  const last = nodes?.[nodes.length - 1];
                  if (event.shiftKey && document.activeElement === first) {
                     event.preventDefault();
                     last?.focus();
                  } else if (!event.shiftKey && document.activeElement === last) {
                     event.preventDefault();
                     first?.focus();
                  }
               }
            }}
         >
            <IconButton label="Close" className="dialog-close" onClick={cancel}>
               <X size={18} />
            </IconButton>
            <h2 id="dialog-title">{request.title}</h2>
            <p>{request.detail}</p>
            <form
               onSubmit={(event) => {
                  event.preventDefault();
                  submit();
               }}
            >
               {request.initial !== undefined && (
                  <input ref={input} aria-label={request.title} value={value} onChange={(event) => setValue(event.target.value)} maxLength={150} />
               )}
               <div className="dialog-actions">
                  <Button type="button" onClick={cancel}>
                     Cancel
                  </Button>
                  <Button className={request.danger ? "destructive" : "primary"} disabled={request.initial !== undefined && !value.trim()}>
                     <Check size={16} />
                     {request.confirm}
                  </Button>
               </div>
            </form>
         </div>
      </div>
   );
}
