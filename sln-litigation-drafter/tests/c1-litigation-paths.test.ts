import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeLitigationRoot } from "@/lib/litigation-paths";
import { resolveMatterRoot, listMatterFiles, writeMatterFile, listAiFolder } from "@/lib/litigation-sharepoint";
vi.mock("@/lib/sharepoint", () => ({ getGraphToken: async () => "test-token" }));
const fetchMock = vi.fn();
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("fetch", fetchMock); });
const root = "https://sandiva.sharepoint.com/sites/Matters/Shared%20Documents/Alpha";
describe("C-1 conservative roots", () => {
  it("canonicalizes literal spaces, URL host case and a trailing separator only", () => {
    expect(normalizeLitigationRoot(" https://SANDIVA.sharepoint.com/sites/Matters/Shared Documents/Alpha/ ")).toBe(root);
    expect(normalizeLitigationRoot(root.replace("Alpha", "alpha"))).not.toBe(root);
  });
  it.each(["", " ", `${root}/..`, `${root}/%2e%2e`, `${root}/%252e%252e`, `${root}/%2fBeta`, `${root}/%5cBeta`, `${root}/%FF`, `${root}/%`, `${root}/a//b`, `${root}\\b`, `${root}?id=Beta`, `${root}#Beta`, `${root}/Forms/AllItems.aspx`, "http://sandiva.sharepoint.com/sites/A/Docs/B", "https://sandiva.sharepoint.com@evil.test/sites/A/Docs/B", "drive:x:y", `${root}/./a`])("rejects ambiguous root %s", (input) => {
    expect(() => normalizeLitigationRoot(input)).toThrow();
  });
  it("keeps sharing tokens and known e query exact instead of collapsing authority", () => {
    const share = "https://sandiva.sharepoint.com/:f:/s/Matters/AbCdef123?e=aBc";
    expect(normalizeLitigationRoot(share)).toBe(share);
    expect(normalizeLitigationRoot(share.replace("aBc", "abc"))).not.toBe(share);
    expect(() => normalizeLitigationRoot(`${share}&id=Beta`)).toThrow();
  });
});
const json = (data: object) => new Response(JSON.stringify(data), { status: 200 });
describe("C-1 Graph resource identity", () => {
  it("resolves full URLs by exact site and library before registering a folder", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "site-id" }))
      .mockResolvedValueOnce(json({ value: [{ id: "driveA", webUrl: "https://sandiva.sharepoint.com/sites/Matters/Shared%20Documents" }, { id: "driveB", webUrl: "https://sandiva.sharepoint.com/sites/Matters/Other" }] }))
      .mockResolvedValueOnce(json({ id: "rootA", folder: {}, parentReference: { driveId: "driveA" } }));
    expect(await resolveMatterRoot(root)).toEqual({ driveId: "driveA", itemId: "rootA" });
    expect(fetchMock.mock.calls[2][0]).toBe("https://graph.microsoft.com/v1.0/drives/driveA/root:/Alpha?$select=id,folder,parentReference,remoteItem");
  });
  it("does not register a sharing link to a file or remote shortcut", async () => {
    fetchMock.mockResolvedValue(json({ id: "item", file: {}, parentReference: { driveId: "driveA" } }));
    await expect(resolveMatterRoot("https://sandiva.sharepoint.com/:f:/s/Matters/AbCdef123")).rejects.toThrow();
  });
  it("lists recursive descendants using registered drive identities and excludes remote shortcuts", async () => {
    fetchMock.mockResolvedValueOnce(json({ value: [{ id: "sub", name: "Evidence", folder: {} }, { id: "remote", name: "Other", remoteItem: { folder: {} } }] }))
      .mockResolvedValueOnce(json({ value: [{ id: "item1", name: "proof.pdf", file: {}, size: 100, parentReference: { driveId: "driveA" } }] }));
    const files = await listMatterFiles({ driveId: "driveA", itemId: "rootA" });
    expect(files).toHaveLength(1); expect(files[0]).toMatchObject({ path: "drive:driveA:item1", name: "proof.pdf", folder: "Evidence" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("uses the immutable drive root for both work-product listing and writes", async () => {
    fetchMock.mockImplementation(async () => json({ value: [], webUrl: "https://example.test/output" }));
    await listAiFolder({ driveId: "driveA", itemId: "rootA" });
    await writeMatterFile({ driveId: "driveA", itemId: "rootA" }, "AI/output.json", "{}");
    expect(fetchMock.mock.calls[0][0]).toContain("/drives/driveA/items/rootA:/AI:/children");
    expect(fetchMock.mock.calls[1][0]).toContain("/drives/driveA/items/rootA:/AI/output.json:/content");
  });
  it("refuses pagination outside the authorized collection", async () => {
    fetchMock.mockResolvedValueOnce(json({ value: [], "@odata.nextLink": "https://graph.microsoft.com/v1.0/drives/driveB/items/secret/children" }));
    await expect(listMatterFiles({ driveId: "driveA", itemId: "rootA" })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("resume listing preserves paginated in-matter artifact download metadata", async () => {
    const collection = "https://graph.microsoft.com/v1.0/drives/driveA/items/rootA:/AI:/children";
    fetchMock.mockResolvedValueOnce(json({ value: [{ id: "one", name: "analysis_1.json", file: {}, "@microsoft.graph.downloadUrl": "https://download.test/one", lastModifiedDateTime: "2026-09-02" }], "@odata.nextLink": `${collection}?$skiptoken=two` }))
      .mockResolvedValueOnce(json({ value: [{ id: "two", name: "session_meta_1.json", file: {}, "@microsoft.graph.downloadUrl": "https://download.test/two", lastModifiedDateTime: "2026-09-03" }] }));
    expect(await listAiFolder({ driveId: "driveA", itemId: "rootA" })).toEqual([
      { name: "analysis_1.json", downloadUrl: "https://download.test/one", lastModified: "2026-09-02" },
      { name: "session_meta_1.json", downloadUrl: "https://download.test/two", lastModified: "2026-09-03" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
