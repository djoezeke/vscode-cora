import * as path from "path";
import * as vscode from "vscode";

const defaultSample = `\"\"\"Generated Cora sample\"\"\"\n\nimport io\n\nfun main() -> void {\n\tlet message : string = \"Hello from CoraScript\";\n\tio.print(message);\n}\n`;

export function registerWorkspaceCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand("corascript.searchWorkspaceSymbols", async () => {
            const query = await vscode.window.showInputBox({
                prompt: "Find Cora symbols in workspace",
                placeHolder: "Type function, class, or variable name",
            });

            if (query === undefined) {
                return;
            }

            const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                "vscode.executeWorkspaceSymbolProvider",
                query,
            );

            if (!symbols || symbols.length === 0) {
                await vscode.window.showInformationMessage("No matching Cora symbols found.");
                return;
            }

            const selected = await vscode.window.showQuickPick(
                symbols.map((symbol) => ({
                    label: symbol.name,
                    description: symbol.containerName || vscode.SymbolKind[symbol.kind],
                    detail: `${path.basename(symbol.location.uri.fsPath)}:${symbol.location.range.start.line + 1}`,
                    symbol,
                })),
                { placeHolder: "Select a symbol to open" },
            );

            if (!selected) {
                return;
            }

            const target = selected.symbol.location;
            const doc = await vscode.workspace.openTextDocument(target.uri);
            const editor = await vscode.window.showTextDocument(doc);
            editor.selection = new vscode.Selection(target.range.start, target.range.end);
            editor.revealRange(target.range, vscode.TextEditorRevealType.InCenter);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("corascript.createSampleFile", async () => {
            const folder = vscode.workspace.workspaceFolders?.[0];
            if (!folder) {
                await vscode.window.showWarningMessage("Open a workspace folder before creating a Cora sample file.");
                return;
            }

            const fileUri = vscode.Uri.joinPath(folder.uri, "sample.cora");

            try {
                await vscode.workspace.fs.stat(fileUri);
                const overwrite = await vscode.window.showWarningMessage(
                    "sample.cora already exists. Overwrite it?",
                    { modal: true },
                    "Overwrite",
                );

                if (overwrite !== "Overwrite") {
                    return;
                }
            } catch {
                // file does not exist
            }

            await vscode.workspace.fs.writeFile(fileUri, Buffer.from(defaultSample, "utf8"));
            const doc = await vscode.workspace.openTextDocument(fileUri);
            await vscode.window.showTextDocument(doc);
            await vscode.window.showInformationMessage("Created sample.cora.");
        }),
    );
}
