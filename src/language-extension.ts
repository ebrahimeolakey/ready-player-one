import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap } from "@codemirror/view";
import { linter, type Diagnostic } from "@codemirror/lint";
import {
  autocompletion,
  type CompletionContext,
  type Completion,
} from "@codemirror/autocomplete";

export interface DefinitionLocation {
  path: string;
  offset: number;
  line: number;
  column: number;
}
export interface LanguageExtensionOptions {
  call: (method: string, args?: any) => Promise<any>;
  context: { workspaceId?: string; sessionId?: string };
  path: string;
  onOpenDefinition: (location: DefinitionLocation) => void;
  onError?: (error: Error) => void;
}
const kindMap: Record<string, string> = {
  method: "method",
  function: "function",
  property: "property",
  const: "constant",
  let: "variable",
  var: "variable",
  class: "class",
  interface: "interface",
  module: "namespace",
  keyword: "keyword",
  alias: "variable",
  enum: "enum",
};
/** JS/TS only. Recreate extensions when workspace/path changes (useMemo at the integration site). */
export function languageExtensions(
  options: LanguageExtensionOptions,
): Extension[] {
  if (!/\.(?:[cm]?[jt]sx?)$/i.test(options.path)) return [];
  const documentId = crypto.randomUUID();
  const payload = (view: EditorView) => ({
    ...options.context,
    path: options.path,
    documentId,
    text: view.state.doc.toString(),
  });
  const report = (error: unknown) =>
    options.onError?.(
      error instanceof Error ? error : new Error(String(error)),
    );
  const gotoDefinition = (
    view: EditorView,
    offset = view.state.selection.main.head,
  ) => {
    void options
      .call("language.definition", { ...payload(view), offset })
      .then((locations: DefinitionLocation[]) => {
        if (locations[0]) options.onOpenDefinition(locations[0]);
      })
      .catch(report);
    return true;
  };
  const completion = async (context: CompletionContext) => {
    const word = context.matchBefore(/[\p{L}\p{N}_$]*/u);
    if (
      !context.explicit &&
      !word?.text &&
      context.state.sliceDoc(Math.max(0, context.pos - 1), context.pos) !== "."
    )
      return null;
    try {
      const entries = await options.call("language.completions", {
        ...options.context,
        path: options.path,
        documentId,
        text: context.state.doc.toString(),
        offset: context.pos,
      });
      if (context.aborted) return null;
      const from = word?.from ?? context.pos;
      return {
        from,
        options: entries.map((entry: any): Completion => ({
          label: entry.label,
          type: kindMap[entry.kind] || "variable",
          apply: entry.insertText || entry.label,
        })),
        validFor: /^[\p{L}\p{N}_$]*$/u,
      };
    } catch (error) {
      report(error);
      return null;
    }
  };
  return [
    ViewPlugin.fromClass(
      class {
        timer?: ReturnType<typeof setTimeout>;
        constructor(readonly view: EditorView) {
          this.schedule();
        }
        schedule() {
          clearTimeout(this.timer);
          this.timer = setTimeout(() => {
            void options
              .call("language.update", payload(this.view))
              .catch(report);
          }, 200);
        }
        update(update: { docChanged: boolean }) {
          if (update.docChanged) this.schedule();
        }
        destroy() {
          clearTimeout(this.timer);
          void options
            .call("language.close", {
              ...options.context,
              path: options.path,
              documentId,
            })
            .catch(() => {});
        }
      },
    ),
    linter(
      async (view) => {
        const text = view.state.doc.toString();
        try {
          const result: Diagnostic[] = await options.call(
            "language.diagnostics",
            payload(view),
          );
          return view.state.doc.toString() === text ? result : [];
        } catch (error) {
          report(error);
          return [];
        }
      },
      { delay: 500 },
    ),
    autocompletion({ override: [completion] }),
    keymap.of([
      { key: "F12", run: gotoDefinition },
      { key: "Mod-b", run: gotoDefinition },
    ]),
    EditorView.domEventHandlers({
      click(event, view) {
        if (!(event.metaKey || event.ctrlKey)) return false;
        const offset = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (offset === null) return false;
        event.preventDefault();
        return gotoDefinition(view, offset);
      },
    }),
  ];
}
