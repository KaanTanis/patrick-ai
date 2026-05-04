// Tool yükleyicisi: yeni bir tool eklemek için sadece import satırı.
// Side-effect import: register() çağrıları her dosyada modül-yüklenince çalışır.

import "./shell.js";
import "./files.js";
import "./ports.js";
import "./memory.js";

export { dispatchTool, getOpenAISchemas, listTools, register } from "./registry.js";
