// Tool yükleyicisi: yeni bir tool eklemek için sadece import satırı.
// Ortak runtime için registry/dispatchTool burdan dışarı verilir.

import "./shell.js";
import "./files.js";
import "./ports.js";
import "./memory.js";

export { dispatchTool, getOpenAISchemas, listTools, register } from "./registry.js";
