import type { FanOutEdge } from "../topology/schema.js";
import { deriveInstanceId, deriveItemKey } from "../topology/compile.js";
import { getPath, type Activation, type EngineState } from "./state.js";

/** One fan-out branch: its per-instance identity (KTD-12) plus the activation the loop dispatches. */
export interface FanOutBranch {
  instanceId: string;
  itemKey: string;
  activation: Activation;
}

/**
 * Builds one branch per item in the runtime `for_each` list (R3) — N sized
 * from `state` at dispatch time, not declared statically. Each branch's
 * `instanceId` (`${to}:${itemKey}`) is the identity threaded into the join
 * barrier's arrival tracking and the pending-write key (KTD-12).
 */
export function buildFanOutBranches(edge: FanOutEdge, state: EngineState): FanOutBranch[] {
  const list = getPath(state, edge.for_each);
  const items = Array.isArray(list) ? list : [];
  return items.map((item, index) => {
    const itemKey = deriveItemKey(item, index);
    const instanceId = deriveInstanceId(edge.to, itemKey);
    return {
      instanceId,
      itemKey,
      activation: { nodeId: edge.to, instanceId, binding: { key: edge.as, value: item }, itemKey },
    };
  });
}
