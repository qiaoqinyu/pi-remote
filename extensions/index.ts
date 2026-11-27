import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRemote } from "../src/extension.ts";

export default function remote(pi: ExtensionAPI): void {
  registerRemote(pi);
}
