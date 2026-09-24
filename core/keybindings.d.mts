export type KeyboardInput = {
  code?: string;
  defaultPrevented?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  nativeEvent?: { isComposing?: boolean };
};
export const KEYBOARD_ACTIONS: { id: string; label: string; binding: string }[];
export function defaultBindings(os?: string): Record<string, string>;
export function parseBinding(value: string): {
  code: string;
  modifiers: string[];
};
export function validateBindings(
  overrides: Record<string, string>,
  os?: string,
): Record<string, string>;
export function bindingFromEvent(event: KeyboardInput): string | null;
export function matchesBinding(
  event: KeyboardInput,
  action: string,
  overrides?: Record<string, string>,
  os?: string,
): boolean;
export function formatBinding(value: string, os?: string): string;
