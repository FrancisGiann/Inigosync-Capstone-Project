import path from "node:path";
import { pathToFileURL } from "node:url";

const skillDir = "C:/Users/Kiko/.codex/plugins/cache/openai-primary-runtime/presentations/26.1026.10807/skills/Presentations";
const workspaceDir = "C:/Users/Kiko/OneDrive/Documents/Projects/InigoSync (Thesis)";
const buildDir = path.join(workspaceDir, ".codex/presentation-build");
const finalPath = path.join(workspaceDir, "deliverables/IñigoSync_Final_Defense_Nov2026.pptx");
const { finalizePresentation } = await import(pathToFileURL(path.join(skillDir, "container_tools/artifact_tool_utils.mjs")).href);

const result = await finalizePresentation({
  workspaceDir,
  candidatePath: path.join(buildDir, "candidate.pptx"),
  finalPath,
  pythonExecutable: "C:/Users/Kiko/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe",
  integrityValidatorPath: path.join(skillDir, "container_tools/inspect_presentation_package_integrity.py"),
  layoutValidatorPath: path.join(skillDir, "container_tools/inspect_presentation_layout_geometry.py"),
  layoutArgs: [
    "--expected-slide-size-emu", "12192000,6858000",
    "--validate-bullet-geometry",
    "--validate-heading-fit",
  ],
  requiredNativeTableOwnerSlides: [],
  fontPolicy: { basis: "design", families: ["Segoe UI"] },
  verifyArtifactToolImport: true,
  receiptPath: path.join(buildDir, "validation-receipt.json"),
});
console.log(JSON.stringify(result, null, 2));
