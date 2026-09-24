import { JsonLineProcess, Requests } from "./transport.mjs";
import { claudeArgs } from "./runtime.mjs";

/** Ask installed CLIs for their current model catalogs without running a model. */
export async function listProviderModels(
  provider,
  {
    cwd,
    env = process.env,
    command = provider,
    timeoutMs = 20000,
    transportFactory = (cmd, args, options) =>
      new JsonLineProcess(cmd, args, options),
  } = {},
) {
  if (!["codex", "claude"].includes(provider))
    throw new Error("Unknown provider");
  const args =
    provider === "codex"
      ? ["app-server", "--listen", "stdio://"]
      : claudeArgs({});
  const transport = transportFactory(command, args, { cwd, env });
  const requests = new Requests(
    (message) => transport.write(message),
    timeoutMs,
  );
  transport.on("failure", (error) => requests.close(error));
  transport.on("close", () => requests.close());
  transport.on("message", (message) => {
    if (provider === "codex") {
      if (message.id !== undefined && !message.method)
        requests.resolve(message.id, message.result, message.error);
      else if (message.id !== undefined)
        transport.write({
          id: message.id,
          error: {
            code: -32601,
            message: "Catalog client does not handle server requests",
          },
        });
    } else if (message.type === "control_response") {
      const r = message.response || {};
      requests.resolve(
        r.request_id,
        r.response,
        r.subtype === "error" ? new Error(r.error) : null,
      );
    } else if (message.type === "control_request")
      transport.write({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: message.request_id,
          error: "Catalog client does not handle server requests",
        },
      });
  });
  try {
    if (provider === "claude") {
      const result = await requests.request((request_id) => ({
        type: "control_request",
        request_id,
        request: { subtype: "initialize", hooks: null },
      }));
      // The same initialize frame contains account data; deliberately discard it.
      return (result.models || [])
        .map((model) => ({
          id: model.value || model.id || model.model,
          label:
            model.displayName ||
            model.display_name ||
            model.name ||
            model.value,
          description: model.description || "",
          efforts: model.supportedEffortLevels || [],
        }))
        .filter((model) => model.id);
    }
    const rpc = (method, params) =>
      requests.request((id) => ({ id, method, params }));
    await rpc("initialize", {
      clientInfo: { name: "ready_player_one_catalog", version: "0.4.0" },
    });
    transport.write({ method: "initialized" });
    const result = await rpc("model/list", {
      limit: 100,
      includeHidden: false,
    });
    return (result.data || []).map((model) => ({
      id: model.model || model.id,
      label: model.displayName || model.model || model.id,
      description: model.description || "",
      default: model.isDefault || false,
      efforts: (model.supportedReasoningEfforts || []).map(
        (e) => e.reasoningEffort,
      ),
      defaultEffort: model.defaultReasoningEffort,
    }));
  } finally {
    requests.close();
    transport.close();
  }
}
