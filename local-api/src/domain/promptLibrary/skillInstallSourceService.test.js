import assert from "node:assert/strict";
import test from "node:test";
import {
  createSkillInstallSourceService,
  parseGitHubSkillUrl,
} from "./skillInstallSourceService.js";

function response(payload, status = 200) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

test("parses repository, tree and raw SKILL.md GitHub links without allowing arbitrary hosts", () => {
  assert.deepEqual(
    parseGitHubSkillUrl("https://github.com/ndjefn/ozon-listing-flow-skill"),
    {
      owner: "ndjefn",
      repository: "ozon-listing-flow-skill",
      ref: "",
      packagePath: "",
      skillPath: "SKILL.md",
      sourceUrl: "https://github.com/ndjefn/ozon-listing-flow-skill",
    },
  );
  assert.equal(
    parseGitHubSkillUrl(
      "https://github.com/acme/tools/tree/release/skills/ozon",
    ).skillPath,
    "skills/ozon/SKILL.md",
  );
  assert.equal(
    parseGitHubSkillUrl(
      "https://raw.githubusercontent.com/acme/tools/main/skills/ozon/SKILL.md",
    ).packagePath,
    "skills/ozon",
  );
  assert.throws(
    () => parseGitHubSkillUrl("https://example.com/SKILL.md"),
    /只支持 GitHub/u,
  );
});

test("downloads the full readable Skill package, records executable files and never executes them", async () => {
  const calls = [];
  const skillMarkdown = `---\nname: test-skill\ndescription: Test package\n---\n# Test Skill\n\nRead [workflow](references/workflow.md).`;
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/repos/acme/tools"))
      return response({ default_branch: "stable" });
    if (String(url).includes("/git/trees/stable?recursive=1")) {
      return response({
        tree: [
          { type: "blob", path: "SKILL.md", size: 120, sha: "skill-sha" },
          { type: "blob", path: "README.md", size: 30, sha: "readme-sha" },
          {
            type: "blob",
            path: "references/workflow.md",
            size: 40,
            sha: "workflow-sha",
          },
          { type: "blob", path: "scripts/run.py", size: 50, sha: "script-sha" },
        ],
      });
    }
    if (String(url).endsWith("/stable/SKILL.md"))
      return response(skillMarkdown);
    if (String(url).endsWith("/stable/README.md"))
      return response("# Package readme");
    if (String(url).endsWith("/stable/references/workflow.md"))
      return response("# Workflow\n\n1. Inspect\n2. Preview");
    return response("not found", 404);
  };
  const service = createSkillInstallSourceService({ fetchImpl });

  const result = await service.resolve({
    url: "https://github.com/acme/tools",
  });

  assert.equal(result.source.ref, "stable");
  assert.equal(result.source.markdown, skillMarkdown);
  assert.deepEqual(
    result.source.referenceFiles.map((item) => item.path).sort(),
    ["README.md", "references/workflow.md"],
  );
  assert.deepEqual(result.source.executableFiles, ["scripts/run.py"]);
  assert.match(result.source.sourceHash, /^[a-f0-9]{64}$/u);
  assert.equal(
    calls.some((url) => url.endsWith("scripts/run.py")),
    false,
  );
});

test("rejects a repository whose SKILL.md is not a valid Skill document", async () => {
  const service = createSkillInstallSourceService({
    fetchImpl: async (url) => {
      if (String(url).endsWith("/repos/acme/broken"))
        return response({ default_branch: "main" });
      if (String(url).endsWith("/main/SKILL.md"))
        return response("# Missing frontmatter");
      return response({ tree: [] });
    },
  });
  await assert.rejects(
    service.resolve({ url: "https://github.com/acme/broken" }),
    /缺少基础说明/u,
  );
});
