import * as vscode from "vscode";
import { isCoraEditor } from "../utils/languages";

export function registerRunCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand("corascript.runCurrentFile", async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !isCoraEditor(editor)) {
                await vscode.window.showWarningMessage("Open a Cora file to run.");
                return;
            }

            const config = vscode.workspace.getConfiguration("corascript");
            const interpreter = String(config.get<string>("interpreterPath") ?? "").trim() || "cora";
            const filePath = editor.document.uri.fsPath;

            const terminal = vscode.window.createTerminal({ name: "Cora Run" });
            terminal.show(true);
            terminal.sendText(`\"${interpreter}\" \"${filePath}\"`);
        }),
    );
}
