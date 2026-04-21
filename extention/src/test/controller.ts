import { execFile } from "child_process";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);
const CONTROLLER_ID = "corascript.testController";

export function registerTestSupport(context: vscode.ExtensionContext): void {
    const controller = vscode.tests.createTestController(CONTROLLER_ID, "Cora Tests");
    context.subscriptions.push(controller);

    controller.resolveHandler = async (item?: vscode.TestItem) => {
        if (item) {
            await refreshFile(controller, item.uri);
            return;
        }

        await discoverWorkspaceTests(controller);
    };

    controller.createRunProfile(
        "Run Cora Tests",
        vscode.TestRunProfileKind.Run,
        (request, token) => runTests(controller, request, token),
        true,
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("corascript.refreshTests", async () => {
            await discoverWorkspaceTests(controller);
            await vscode.window.showInformationMessage("Cora tests refreshed.");
        }),
    );

    const watcher = vscode.workspace.createFileSystemWatcher("**/*.cora");
    watcher.onDidCreate(async (uri) => {
        await refreshFile(controller, uri);
    });
    watcher.onDidChange(async (uri) => {
        await refreshFile(controller, uri);
    });
    watcher.onDidDelete((uri) => {
        controller.items.delete(uri.toString());
    });

    context.subscriptions.push(watcher);
    void discoverWorkspaceTests(controller);
}

async function discoverWorkspaceTests(controller: vscode.TestController): Promise<void> {
    const files = await vscode.workspace.findFiles("**/*.cora", "**/{node_modules,.git,dist,out}/**");
    const seen = new Set<string>();

    for (const file of files) {
        seen.add(file.toString());
        await refreshFile(controller, file);
    }

    const idsToRemove: string[] = [];
    controller.items.forEach((item) => {
        if (!seen.has(item.id)) {
            idsToRemove.push(item.id);
        }
    });

    for (const id of idsToRemove) {
        controller.items.delete(id);
    }
}

async function refreshFile(controller: vscode.TestController, uri: vscode.Uri | undefined): Promise<void> {
    if (!uri || uri.scheme !== "file" || path.extname(uri.fsPath).toLowerCase() !== ".cora") {
        return;
    }

    const id = uri.toString();
    let item = controller.items.get(id);

    if (!item) {
        item = controller.createTestItem(id, path.basename(uri.fsPath), uri);
        controller.items.add(item);
    }

    const document = await vscode.workspace.openTextDocument(uri);
    const content = document.getText();
    const testNames = Array.from(content.matchAll(/^\s*fun\s+(test_[A-Za-z0-9_]+)\s*\(/gm)).map((match) => match[1]);

    item.children.replace(
        testNames.map((name) => {
            const childId = `${id}::${name}`;
            const child = controller.createTestItem(childId, name, uri);
            return child;
        }),
    );
}

async function runTests(
    controller: vscode.TestController,
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
): Promise<void> {
    const run = controller.createTestRun(request);

    try {
        const queue: vscode.TestItem[] = [];
        if (request.include && request.include.length > 0) {
            queue.push(...request.include);
        } else {
            controller.items.forEach((item) => queue.push(item));
        }

        const seen = new Set<string>();
        while (queue.length > 0) {
            const item = queue.pop();
            if (!item || seen.has(item.id)) {
                continue;
            }
            seen.add(item.id);

            if (request.exclude?.some((excluded) => excluded.id === item.id)) {
                continue;
            }

            if (item.children.size > 0) {
                item.children.forEach((child) => queue.push(child));
                continue;
            }

            await runTestItem(item, run, token);
        }
    } finally {
        run.end();
    }
}

async function runTestItem(item: vscode.TestItem, run: vscode.TestRun, token: vscode.CancellationToken): Promise<void> {
    if (!item.uri || token.isCancellationRequested) {
        return;
    }

    const startedAt = Date.now();
    run.started(item);

    const interpreter = String(vscode.workspace.getConfiguration("corascript").get<string>("interpreterPath") ?? "").trim() || "cora";

    try {
        await execFileAsync(interpreter, [item.uri.fsPath], {
            cwd: path.dirname(item.uri.fsPath),
            windowsHide: true,
            timeout: 60000,
        });

        run.passed(item, Date.now() - startedAt);
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown test failure";
        run.failed(item, new vscode.TestMessage(message), Date.now() - startedAt);
    }
}
