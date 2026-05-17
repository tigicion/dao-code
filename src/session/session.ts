import type { ChatMessage } from "../client/types.js";
import type { Mode } from "../tools/tools_for_mode.js";

export class Session {
  messages: ChatMessage[];
  model: string;
  mode: Mode = "normal";
  private readonly systemPrompt: string;

  constructor(systemPrompt: string, model: string) {
    this.systemPrompt = systemPrompt;
    this.model = model;
    this.messages = [{ role: "system", content: systemPrompt }];
  }

  addUser(text: string): void {
    this.messages.push({ role: "user", content: text });
  }

  clear(): void {
    this.messages = [{ role: "system", content: this.systemPrompt }];
  }

  setModel(model: string): void {
    this.model = model;
  }

  toggleMode(): Mode {
    this.mode = this.mode === "normal" ? "plan" : "normal";
    return this.mode;
  }
}
