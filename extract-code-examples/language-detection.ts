import * as fs from "fs";
import * as path from "path";
import type { FernMetadata, Language } from "./types";

export function detectLanguage(rootDir: string): { language: Language; metadata: FernMetadata } {
    const metadataPath = path.join(rootDir, ".fern", "metadata.json");
    if (!fs.existsSync(metadataPath)) {
        throw new Error(`Fern metadata not found at ${metadataPath}`);
    }
    const metadata: FernMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));

    if (metadata.generatorName.includes("typescript")) return { language: "typescript", metadata };
    if (metadata.generatorName.includes("python")) return { language: "python", metadata };
    if (metadata.generatorName.includes("java")) return { language: "java", metadata };

    throw new Error(`Unsupported generator: ${metadata.generatorName}`);
}

export function getPackageName(rootDir: string, language: Language): string {
    switch (language) {
        case "typescript": {
            const pkgPath = path.join(rootDir, "package.json");
            if (fs.existsSync(pkgPath)) {
                return JSON.parse(fs.readFileSync(pkgPath, "utf-8")).name || "unknown";
            }
            return "unknown";
        }
        case "python": {
            const pyprojectPath = path.join(rootDir, "pyproject.toml");
            if (fs.existsSync(pyprojectPath)) {
                const content = fs.readFileSync(pyprojectPath, "utf-8");
                const match = content.match(/name\s*=\s*"([^"]+)"/);
                if (match) return match[1];
            }
            return "unknown";
        }
        case "java": {
            const gradlePath = path.join(rootDir, "build.gradle");
            if (fs.existsSync(gradlePath)) {
                const content = fs.readFileSync(gradlePath, "utf-8");
                const groupMatch = content.match(/group\s*=\s*['"]([^'"]+)['"]/);
                const artifactMatch = content.match(/artifactId\s*=\s*['"]([^'"]+)['"]/);
                if (groupMatch && artifactMatch) return `${groupMatch[1]}:${artifactMatch[1]}`;
                if (groupMatch) return groupMatch[1];
            }
            return "unknown";
        }
    }
}
