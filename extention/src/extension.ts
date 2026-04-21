import * as vscode from "vscode";
import { CoraLspClientManager } from "./cora/client";
import { registerInterpreterCommands } from "./commands/interpreter";
import { registerFormatCommands } from "./commands/format";
import { registerRunCommands } from "./commands/run";
import { registerServerCommands } from "./commands/server";
import { registerWorkspaceCommands } from "./commands/workspace";
import { registerDebugSupport } from "./debug/configuration";
import { registerTestSupport } from "./test/controller";
import { isCoraEditor } from "./utils/languages";

let lspManager: CoraLspClientManager | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    lspManager = new CoraLspClientManager(context);
    context.subscriptions.push(lspManager);

    registerInterpreterCommands(context);
    registerFormatCommands(context);
    registerRunCommands(context);
    registerServerCommands(context, lspManager);
    registerWorkspaceCommands(context);
    registerDebugSupport(context);
    registerTestSupport(context);

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor: vscode.TextEditor | undefined) => {
            if (!lspManager) {
                return;
            }

            if (isCoraEditor(editor)) {
                lspManager.showStatus();
            } else {
                lspManager.hideStatus();
            }
        }),
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent) => {
            if (!event.affectsConfiguration("corascript.trace.server") || !lspManager) {
                return;
            }

            lspManager.applyTraceFromConfiguration();
        }),
    );

    if (isCoraEditor(vscode.window.activeTextEditor)) {
        lspManager.showStatus();
    } else {
        lspManager.hideStatus();
    }

    await lspManager.start();
}

export async function deactivate(): Promise<void> {
    if (!lspManager) {
        return;
    }

    const active = lspManager;
    lspManager = undefined;
    await active.shutdown();
}
