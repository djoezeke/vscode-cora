import * as path from "path";
import * as vscode from "vscode";
import { isCoraEditor } from "../utils/languages";

class CoraDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    public async provideDebugConfigurations(
        folder: vscode.WorkspaceFolder | undefined,
    ): Promise<vscode.DebugConfiguration[]> {
        const program = resolveActiveProgramPath();
        const cwd = folder?.uri.fsPath ?? (program ? path.dirname(program) : undefined);

        return [
            {
                type: "cora",
                request: "launch",
                name: "Debug Cora File",
                program,
                cwd,
            },
        ];
    }

    public async resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined,
        debugConfiguration: vscode.DebugConfiguration,
    ): Promise<vscode.DebugConfiguration | undefined> {
        const program = String(debugConfiguration.program ?? "").trim() || resolveActiveProgramPath();
        if (!program) {
            await vscode.window.showErrorMessage("Set a Cora file as active editor or define 'program' in launch.json.");
            return undefined;
        }

        const interpreter = String(debugConfiguration.interpreterPath ?? getInterpreterPath()).trim();
        const cwd = String(debugConfiguration.cwd ?? "").trim() || folder?.uri.fsPath || path.dirname(program);

        return {
            ...debugConfiguration,
            type: "cora",
            request: String(debugConfiguration.request ?? "launch"),
            name: String(debugConfiguration.name ?? "Debug Cora File"),
            program,
            cwd,
            interpreterPath: interpreter,
        };
    }
}

export function registerDebugSupport(context: vscode.ExtensionContext): void {
    const provider = new CoraDebugConfigurationProvider();

    context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider("cora", provider));

    context.subscriptions.push(
        vscode.commands.registerCommand("corascript.debugCurrentFile", async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !isCoraEditor(editor)) {
                await vscode.window.showWarningMessage("Open a Cora file to debug.");
                return;
            }

            const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
            await vscode.debug.startDebugging(folder, {
                type: "cora",
                request: "launch",
                name: "Debug Current Cora File",
                program: editor.document.uri.fsPath,
                cwd: folder?.uri.fsPath ?? path.dirname(editor.document.uri.fsPath),
            });
        }),
    );
}

function resolveActiveProgramPath(): string {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isCoraEditor(editor)) {
        return "";
    }

    return editor.document.uri.fsPath;
}

function getInterpreterPath(): string {
    const configured = String(vscode.workspace.getConfiguration("corascript").get<string>("interpreterPath") ?? "").trim();
    return configured.length > 0 ? configured : "cora";
}
