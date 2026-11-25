import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { apiCommand } from "../src/commands/api.js";
import { streamCommand, postCommand } from "../src/commands/stream.js";
import { searchCommand } from "../src/commands/search.js";
import { attachmentCommand } from "../src/commands/attachment.js";
import { ERR, OK, OK_LIST, contextFor, lastUrl, type FakeResponse } from "./helpers.js";

describe("api escape hatch", () => {
  it("GET passes --query pairs and list flags, and shrinks long strings", async () => {
    const { ctx, calls } = contextFor([OK({ key: "x".repeat(600), nested: { ok: true } })]);
    const out = await apiCommand(["get", "Metadata", "--query", "key=scopes", "--limit", "5"], ctx);
    const url = lastUrl(calls);
    expect(url.pathname).toBe("/api/v1/Metadata");
    expect(url.searchParams.get("key")).toBe("scopes");
    expect(url.searchParams.get("maxSize")).toBe("5");
    expect(JSON.stringify(out)).toContain("use --full");
    expect(JSON.stringify(out)).toContain('"request":"GET /Metadata"');
  });

  it("--json returns the raw payload; --full disables shrinking", async () => {
    const long = "y".repeat(600);
    const { ctx } = contextFor([OK({ v: long })]);
    expect(JSON.stringify(await apiCommand(["get", "App/user", "--full"], ctx))).toContain(long);
    const { ctx: ctx2 } = contextFor([OK({ v: long })]);
    expect(JSON.parse((await apiCommand(["get", "App/user", "--json"], ctx2)) as string)).toEqual({ v: long });
  });

  it("writes need --confirm before any request, and accept JSON or @file bodies", async () => {
    const { ctx, calls } = contextFor([OK(true)]);
    await expect(apiCommand(["put", "Preferences/u1", "--body", '{"timezone":"UTC"}'], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(calls).toHaveLength(0);
    await apiCommand(["put", "Preferences/u1", "--body", '{"timezone":"UTC"}', "--confirm"], ctx);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.body).toEqual({ timezone: "UTC" });

    const dir = mkdtempSync(resolve(tmpdir(), "espo-api-"));
    writeFileSync(resolve(dir, "body.json"), '{"a":1}');
    const { ctx: ctx2, calls: calls2 } = contextFor([OK(true)]);
    await apiCommand(["post", "Team/t1/userPosition", "--body", `@${resolve(dir, "body.json")}`, "--confirm"], ctx2);
    expect(calls2[0]!.body).toEqual({ a: 1 });
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects invalid bodies and paths with exit-2 errors", async () => {
    const { ctx, calls } = contextFor([OK(true)]);
    await expect(apiCommand(["post", "Lead", "--body", "{bad", "--confirm"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(apiCommand(["get", "../etc/passwd"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(apiCommand(["get", "Lead?maxSize=1"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(apiCommand(["post", "Lead", "--confirm"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(calls).toHaveLength(0);
    expect(await apiCommand(["bogus"], ctx)).toContain("raw EspoCRM REST escape hatch");
  });

  it("surfaces API errors", async () => {
    const { ctx } = contextFor([ERR(404)]);
    await expect(apiCommand(["get", "Lead/nope"], ctx)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("stream and posts", () => {
  it("stream lists notes compactly", async () => {
    const { ctx, calls } = contextFor([OK_LIST([{ id: "n1", type: "Status", createdByName: "Ada", createdAt: "2026-11-24 10:00:00", parentType: "Lead", parentName: "Acme", data: { statusValue: "New", statusField: "status", other: null } }, { id: "n2", type: "Post", createdByName: "Bob", createdAt: "2026-11-24 11:00:00", post: "Called. " + "long ".repeat(60) }], -1)]);
    const out = await streamCommand(["--limit", "2"], ctx);
    expect(lastUrl(calls).pathname).toBe("/api/v1/Stream");
    expect(JSON.stringify(out)).toContain("statusValue=New, statusField=status");
    expect(JSON.stringify(out)).toContain("…");
  });

  it("post create uploads attachments and creates a Post note (gated)", async () => {
    const { ctx, calls } = contextFor([OK({ id: "att1" }), OK({ id: "note1" })]);
    await expect(postCommand(["create", "Case", "c1", "--text", "hi"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(calls).toHaveLength(0);
    const dir = mkdtempSync(resolve(tmpdir(), "espo-post-"));
    writeFileSync(resolve(dir, "a.txt"), "hello");
    const out = await postCommand(["create", "Case", "c1", "--text", "hi", "--attach", resolve(dir, "a.txt"), "--attach-id", "x1", "--confirm"], ctx);
    const upload = calls[0]!;
    expect(new URL(upload.url).pathname).toBe("/api/v1/Attachment");
    expect(upload.body).toMatchObject({ name: "a.txt", type: "text/plain", role: "Attachment", field: "attachments", parentType: "Note" });
    expect(String((upload.body as { file: string }).file)).toMatch(/^data:text\/plain;base64,aGVsbG8=$/);
    expect(calls[1]!.body).toEqual({ type: "Post", parentType: "Case", parentId: "c1", post: "hi", attachmentsIds: ["x1", "att1"] });
    expect(out).toMatchObject({ posted: { id: "note1" } });
    rmSync(dir, { recursive: true, force: true });
  });

  it("pin/unpin/react/unreact/reactors hit the note routes", async () => {
    const { ctx, calls } = contextFor([OK(true), OK(true), OK(true), OK(true), OK_LIST([{ id: "u1", name: "Ada" }])]);
    await postCommand(["pin", "n1"], ctx);
    await postCommand(["unpin", "n1"], ctx);
    await postCommand(["react", "n1", "--type", "Like"], ctx);
    await postCommand(["unreact", "n1", "--type", "Like"], ctx);
    const out = await postCommand(["reactors", "n1", "--type", "Like"], ctx);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "POST /api/v1/Note/n1/pin",
      "DELETE /api/v1/Note/n1/pin",
      "POST /api/v1/Note/n1/myReactions/Like",
      "DELETE /api/v1/Note/n1/myReactions/Like",
      "GET /api/v1/Note/n1/reactors/Like",
    ]);
    expect(out).toMatchObject({ count: 1, users: [{ id: "u1", name: "Ada" }] });
    await expect(postCommand(["react", "n1"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("global search", () => {
  it("groups results by _scope and reports empty states", async () => {
    const { ctx, calls } = contextFor([OK_LIST([{ _scope: "Lead", id: "l1", name: "Acme Lead", status: "New" }, { _scope: "Contact", id: "c1", name: "Ada" }])]);
    const out = await searchCommand(["acme", "--size", "3"], ctx);
    expect(lastUrl(calls).pathname).toBe("/api/v1/GlobalSearch");
    expect(lastUrl(calls).searchParams.get("q")).toBe("acme");
    expect(lastUrl(calls).searchParams.get("maxSize")).toBe("3");
    expect(out).toMatchObject({ count: 2, by_type: { Lead: 1, Contact: 1 }, Lead: [{ id: "l1", name: "Acme Lead", status: "New" }] });
    const { ctx: ctx2 } = contextFor([OK_LIST([], -2)]);
    expect(await searchCommand(["nothing"], ctx2)).toMatchObject({ count: 0, result: expect.stringContaining("0 results") });
  });
});

describe("attachments", () => {
  it("upload posts a base64 data URL with field/role/parent hints", async () => {
    const { ctx, calls } = contextFor([OK({ id: "att9", name: "r.pdf" })]);
    const dir = mkdtempSync(resolve(tmpdir(), "espo-att-"));
    writeFileSync(resolve(dir, "r.pdf"), "%PDF-1.4");
    const out = await attachmentCommand(["upload", "--file", resolve(dir, "r.pdf"), "--field", "file", "--related-type", "Document", "--related-id", "d1", "--role", "Attachment File"], ctx);
    expect(calls[0]!.body).toMatchObject({ name: "r.pdf", type: "application/pdf", role: "Attachment File", field: "file", relatedType: "Document", relatedId: "d1", file: "data:application/pdf;base64,JVBERi0xLjQ=" });
    expect(out).toMatchObject({ uploaded: { id: "att9", size: 8, type: "application/pdf" } });
    expect(JSON.stringify(out)).toContain("att9");
    rmSync(dir, { recursive: true, force: true });
  });

  it("upload validates pairing and readable files before any request", async () => {
    const { ctx, calls } = contextFor([OK({})]);
    await expect(attachmentCommand(["upload", "--file", "/nonexistent/x.txt"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(attachmentCommand(["upload", "--file", "x.txt", "--parent-type", "Note"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(attachmentCommand(["upload"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(calls).toHaveLength(0);
  });

  it("download writes the server filename or --out path", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "espo-dl-"));
    const bytes = Buffer.from("file-bytes");
    const { ctx } = contextFor([{ status: 200, body: bytes.toString("binary"), headers: { "content-type": "text/plain", "content-disposition": 'attachment; filename="note.txt"' } } as FakeResponse]);
    const out = await attachmentCommand(["download", "a1", "--out", dir], ctx);
    expect(readFileSync(resolve(dir, "note.txt"), "utf8")).toBe("file-bytes");
    expect(out).toMatchObject({ downloaded: { id: "a1", type: "text/plain", filename: "note.txt" } });
    rmSync(dir, { recursive: true, force: true });
  });

  it("get and gated delete", async () => {
    const { ctx, calls } = contextFor([OK({ id: "a1", name: "x.txt", size: 3, type: "text/plain" }), OK(true)]);
    expect(await attachmentCommand(["get", "a1"], ctx)).toMatchObject({ attachment: { id: "a1", name: "x.txt", size: 3 } });
    await expect(attachmentCommand(["delete", "a1"], ctx)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(calls).toHaveLength(1);
    await attachmentCommand(["delete", "a1", "--confirm"], ctx);
    expect(calls[1]!.method).toBe("DELETE");
  });
});
