import * as vscode from "vscode";

export function registerInterpreterCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand("corascript.showInterpreter", async () => {
            const config = vscode.workspace.getConfiguration("corascript");
            const configuredPath = String(config.get<string>("interpreterPath") ?? "").trim();
            const resolved = configuredPath.length > 0 ? configuredPath : "cora (from PATH)";
            await vscode.window.showInformationMessage(`Cora interpreter: ${resolved}`);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("corascript.selectInterpreter", async () => {
            const selected = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectMany: false,
                canSelectFolders: false,
                openLabel: "Use Cora Interpreter",
            });

            if (!selected || selected.length === 0) {
                return;
            }

            const config = vscode.workspace.getConfiguration("corascript");
            await config.update("interpreterPath", selected[0].fsPath, vscode.ConfigurationTarget.Workspace);
            await vscode.window.showInformationMessage(`Cora interpreter set to: ${selected[0].fsPath}`);
        }),
    );
}
