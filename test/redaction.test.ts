import { describe, expect, it } from "vitest";
import { recordCommand } from "../src/commands/record.js";
import { apiCommand } from "../src/commands/api.js";
import { meCommand } from "../src/commands/me.js";
import { OK, OK_LIST, contextFor } from "./helpers.js";

/** Secrets returned by the server must never reach the transcript, even with --json. */
describe("secret redaction", () => {
  const USER_RECORD = {
    id: "u1", userName: "api-bot", name: "Bot", apiKey: "KEYVALUE123456", smtpPassword: "pw-value-999", token: "tok-value-777",
    preferences: { smtpPassword: "nested-pw-555", fine: "ok" }, isActive: true, empty: null,
  };

  it("record get masks apiKey/password/token fields (plain and --json)", async () => {
    const { ctx } = contextFor([OK(USER_RECORD)]);
    for (const args of [["get", "User", "u1"], ["get", "User", "u1", "--json"]]) {
      const out = JSON.stringify(await recordCommand(args, ctx));
      expect(out).not.toContain("KEYVALUE123456");
      expect(out).not.toContain("pw-value-999");
      expect(out).not.toContain("tok-value-777");
      expect(out).toContain("<redacted>");
      expect(out).toContain("api-bot");
    }
  });

  it("record list --json masks per-row secrets", async () => {
    const { ctx } = contextFor([OK_LIST([USER_RECORD])]);
    const out = JSON.stringify(await recordCommand(["list", "User", "--json"], ctx));
    expect(out).not.toContain("KEYVALUE123456");
  });

  it("api get masks secrets deeply, including in --json and --full", async () => {
    for (const args of [["get", "User/u1"], ["get", "User/u1", "--json"], ["get", "User/u1", "--full"]]) {
      const { ctx } = contextFor([OK({ user: USER_RECORD, list: [USER_RECORD] })]);
      const out = JSON.stringify(await apiCommand(args, ctx));
      expect(out).not.toContain("KEYVALUE123456");
      expect(out).not.toContain("nested-pw-555");
      expect(out).toContain("<redacted>");
    }
  });

  it("me --json redacts the auth token", async () => {
    const { ctx } = contextFor([OK({ token: "TOKENVALUE123456", user: { id: "u1", userName: "ada" } })]);
    const out = JSON.stringify(await meCommand(["--json"], ctx));
    expect(out).not.toContain("TOKENVALUE123456");
    expect(out).toContain("<redacted>");
  });

  it("create/update responses are masked too", async () => {
    const { ctx } = contextFor([OK(USER_RECORD)]);
    const out = JSON.stringify(await recordCommand(["create", "User", "--set", "userName=bot", "--confirm"], ctx));
    expect(out).not.toContain("KEYVALUE123456");
  });
});
