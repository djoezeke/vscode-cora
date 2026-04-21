import * as vscode from "vscode";
import { isCoraEditor } from "../utils/languages";

export function registerFormatCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand("corascript.formatCurrentFile", async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !isCoraEditor(editor)) {
                await vscode.window.showWarningMessage("Open a Cora file to format.");
                return;
            }

            await vscode.commands.executeCommand("editor.action.formatDocument");
        }),
    );
}
