import * as vscode from "vscode";
import { CoraLspClientManager } from "../cora/client";

export function registerServerCommands(context: vscode.ExtensionContext, manager: CoraLspClientManager): void {
    context.subscriptions.push(
        vscode.commands.registerCommand("corascript.showServerOutput", async () => {
            manager.showOutput(true);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("corascript.restartLanguageServer", async () => {
            manager.showStatus();
            await manager.restart();
            await vscode.window.showInformationMessage("Cora language server restarted.");
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("corascript.startLanguageServer", async () => {
            manager.showStatus();
            await manager.start();
            await vscode.window.showInformationMessage("Cora language server started.");
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("corascript.stopLanguageServer", async () => {
            await manager.stop();
            await vscode.window.showInformationMessage("Cora language server stopped.");
        }),
    );
}
