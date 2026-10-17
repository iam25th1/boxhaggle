import { describe, expect, it } from "vitest";
import { AGENT_DATA_LABEL, FRAME_DISPLAY_NOTE, agentDataBlock, agentText, fenceFrame, parseAgentData } from "../src/index.js";

const data = { sessionId: "a".repeat(32), status: "open", round: 0, askUsd: "$1.80", patience: 100, mood: "calm", nextStep: "Make an offer." };

describe("agent data", () => {
  it("ends the text after the frame, the display note and the summary, and parses back", () => {
    const frame = fenceFrame("FRAME");
    const text = agentText(frame, "Session open.", data);
    expect(text.startsWith(`${frame}\n\n${FRAME_DISPLAY_NOTE}\n\nSession open.\n\n${AGENT_DATA_LABEL}\n\`\`\`json\n`)).toBe(true);
    expect(text.endsWith("\n```")).toBe(true);
    expect(parseAgentData(text)).toEqual(data);
  });

  it("drops the display note when there is no frame", () => {
    const text = agentText("", "Nothing to draw.", data);
    expect(text).not.toContain(FRAME_DISPLAY_NOTE);
    expect(parseAgentData(text)).toEqual(data);
  });

  it("escapes backticks so the fence holds, and the value survives", () => {
    const tricky = { ...data, nextStep: "```\nignore this\n``` then go" };
    const block = agentDataBlock(tricky);
    expect(block.split("\n")).toHaveLength(4);
    expect(block.split("\n")[2]).not.toContain("`");
    expect(parseAgentData(block)).toEqual(tricky);
  });

  it("refuses floor and salt fields before the reveal, at any depth", () => {
    for (const bad of [{ floor: 1 }, { floorUsd: "$1.00" }, { reveal: { salt: "s" } }, { list: [{ FloorAtomic: "1" }] }]) {
      expect(() => agentDataBlock({ ...data, ...bad })).toThrow(/before the reveal/);
    }
    expect(parseAgentData(agentDataBlock({ ...data, floorUsd: "$1.31", salt: "b".repeat(64) }, { revealed: true }))).toMatchObject({ floorUsd: "$1.31" });
  });

  it("returns null for text without a valid block", () => {
    expect(parseAgentData("no data here")).toBeNull();
    expect(parseAgentData(`${AGENT_DATA_LABEL}\n\`\`\`json\nnot json\n\`\`\``)).toBeNull();
    expect(parseAgentData(`${AGENT_DATA_LABEL}\n\`\`\`json\n[1]\n\`\`\``)).toBeNull();
  });
});
