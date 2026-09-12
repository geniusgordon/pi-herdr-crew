import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { assertResultToken, readResultCapability } from "./result-capability.js";
import { publishResult } from "./result-publish.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "crew_submit_result",
    label: "Submit Crew Result",
    description: "Write the complete Markdown answer to this crew member's current result file.",
    promptSnippet: "Submit the complete Markdown answer for the current crew task",
    promptGuidelines: [
      "Call crew_submit_result once after the crew task is complete, then reply with one short DONE or BLOCKED line.",
    ],
    parameters: Type.Object({
      token: Type.String({ description: "The task token from the crew brief." }),
      content: Type.String({ description: "The complete Markdown answer." }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const sessionPath = ctx.sessionManager.getSessionFile();
      if (!sessionPath) throw new Error("crew_submit_result needs a persistent crew session.");
      const capability = await readResultCapability(sessionPath);
      const resultPath = assertResultToken(capability, params.token);

      signal?.throwIfAborted();
      await publishResult(resultPath, params.content);
      return {
        content: [{ type: "text" as const, text: "Crew result submitted." }],
        details: { bytes: Buffer.byteLength(params.content) },
      };
    },
  });
}
