import { loadNativeBinding } from "./binding.js";
import { Logger } from "./logger.js";

export * from "./binding.js";
export * from "./logger.js";
export * from "./errors.js";

export function initCore(): ReturnType<typeof loadNativeBinding> {
  const binding = loadNativeBinding();
  binding.initLogger();
  Logger.info("AutoDoc Core initialized via NAPI-RS bridge");
  return binding;
}
