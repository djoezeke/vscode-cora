import * as fs from "fs";
import * as path from "path";
import { Location, Position, Range } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { BuiltinModuleDoc } from "./builtins";

export function resolveModuleDefinition(
    document: TextDocument,
    position: Position,
    word: string,
    workspaceRoots: string[],
    builtinModuleDocs: Map<string, BuiltinModuleDoc>,
): Location | null {
    const lineText = document.getText().split(/\r?\n/)[position.line] ?? "";

    if (!new RegExp(`^\\s*import\\s+${word}\\b`).test(lineText)) {
        return null;
    }

    const resolvedUri = resolveWorkspaceModuleUri(document, word, workspaceRoots)
        ?? ensureModuleStubAndGetUri(word, workspaceRoots, builtinModuleDocs);
    if (!resolvedUri) {
        return null;
    }

    return Location.create(resolvedUri, Range.create(Position.create(0, 0), Position.create(0, 0)));
}

function resolveWorkspaceModuleUri(document: TextDocument, moduleName: string, workspaceRoots: string[]): string | null {
    const sourceDir = path.dirname(URI.parse(document.uri).fsPath);
    const searchRoots = [sourceDir, ...workspaceRoots];
    const extensions = [".cora", ".cs", ".coratmpl"];

    for (const root of searchRoots) {
        for (const extension of extensions) {
            const directPath = path.join(root, `${moduleName}${extension}`);
            if (fs.existsSync(directPath)) {
                return URI.file(directPath).toString();
            }
        }
    }

    return null;
}

function ensureModuleStubAndGetUri(
    moduleName: string,
    workspaceRoots: string[],
    builtinModuleDocs: Map<string, BuiltinModuleDoc>,
): string | null {
    const moduleDoc = builtinModuleDocs.get(moduleName);
    const root = workspaceRoots[0];
    if (!root) {
        return null;
    }

    const stubDirectory = path.join(root, ".cora-stubs");
    const stubPath = path.join(stubDirectory, `${moduleName}.cora`);

    fs.mkdirSync(stubDirectory, { recursive: true });
    if (!fs.existsSync(stubPath)) {
        fs.writeFileSync(stubPath, renderModuleStub(moduleName, moduleDoc), "utf-8");
    }

    return URI.file(stubPath).toString();
}

function renderModuleStub(moduleName: string, moduleDoc?: BuiltinModuleDoc): string {
    if (!moduleDoc) {
        return `# Module template for ${moduleName}\n# Add exported classes, functions, and constants here.\n\n`;
    }

    const lines: string[] = [
        `# Builtin module: ${moduleDoc.name}`,
        `# ${moduleDoc.documentation}`,
        "",
    ];

    for (const fn of moduleDoc.functions) {
        lines.push(`# ${fn.documentation}`);
        lines.push(`fun ${fn.signature} {}`);
        lines.push("");
    }

    for (const classDoc of moduleDoc.classes) {
        lines.push(`# ${classDoc.documentation}`);
        lines.push(`class ${classDoc.name} {`);
        for (const method of classDoc.methods) {
            lines.push(`\t# ${method.documentation}`);
            lines.push(`\tfun ${method.signature} {}`);
        }
        lines.push("}");
        lines.push("");
    }

    return `${lines.join("\n").trimEnd()}\n`;
}
