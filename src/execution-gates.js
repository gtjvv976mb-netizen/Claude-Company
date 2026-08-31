/**
 * Structural release gate for the retired browser RPC relay. Keeping the response
 * in a pure production helper lets CI exercise the exact value returned by Office
 * without opening a network listener.
 */
export function retiredBrowserRpcResponse() {
  return {
    status: 410,
    body: { error: "browser RPC relay retired; live signing is disabled" },
  };
}
