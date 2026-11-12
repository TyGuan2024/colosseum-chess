import { chooseAIAction } from "./ai-engine.mjs";
import { chooseAIActionV2 } from "./ai-engine-v2.mjs";
import { chooseAIActionV3 } from "./ai-engine-v3.mjs";

export const AI_VERSIONS = Object.freeze(["v1", "v2", "v3"]);
export const DEFAULT_AI_VERSION = "v2";

export function normalizeAIVersion(value) {
  return AI_VERSIONS.includes(value) ? value : DEFAULT_AI_VERSION;
}

export function chooseVersionedAIAction(publicState, color, options = {}) {
  const aiVersion = normalizeAIVersion(options.aiVersion);
  if (aiVersion === "v3") return chooseAIActionV3(publicState, color, options);
  if (aiVersion === "v1") {
    return { ...chooseAIAction(publicState, color, options), aiVersion };
  }
  return chooseAIActionV2(publicState, color, options);
}
