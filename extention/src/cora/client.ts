import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
    LanguageClient,
    LanguageClientOptions,
    RevealOutputChannelOn,
    ServerOptions,
    State,
    TransportKind,
} from "vscode-languageclient/node";
import { resolveTraceSetting } from "../utils/config";

export class CoraLspClientManager implements vscode.Disposable {
    private readonly client: LanguageClient;
    private readonly output: vscode.OutputChannel;
    private readonly status: vscode.StatusBarItem;

    public constructor(context: vscode.ExtensionContext) {
        this.output = vscode.window.createOutputChannel("Cora Language Server");
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);

        this.status.name = "Cora LSP Status";
        this.status.command = "corascript.restartLanguageServer";
        this.status.text = "$(loading~spin) Cora LSP";
        this.status.tooltip = "Cora language server is starting";

        context.subscriptions.push(this.output, this.status);
        this.client = this.createClient(context);

        this.client.onDidChangeState((event) => {
            if (event.newState === State.Running) {
                this.status.text = "$(check) Cora LSP";
                this.status.tooltip = "Cora language server is running";
                return;
            }

            if (event.newState === State.Stopped) {
                this.status.text = "$(error) Cora LSP";
                this.status.tooltip = "Cora language server stopped. Click to restart.";
                return;
            }

            this.status.text = "$(loading~spin) Cora LSP";
            this.status.tooltip = "Cora language server is starting";
        });
    }

    public showStatus(): void {
        this.status.show();
    }

    public hideStatus(): void {
        this.status.hide();
    }

    public showOutput(preserveFocus = true): void {
        this.output.show(preserveFocus);
    }

    public applyTraceFromConfiguration(): void {
        this.client.setTrace(resolveTraceSetting());
    }

    public async start(): Promise<void> {
        if (this.client.state === State.Running || this.client.state === State.Starting) {
            return;
        }

        await this.client.start();
        this.applyTraceFromConfiguration();
    }

    public async stop(): Promise<void> {
        if (this.client.state === State.Stopped) {
            return;
        }

        await this.client.stop();
    }

    public async restart(): Promise<void> {
        await this.stop();
        await this.start();
    }

    public async shutdown(): Promise<void> {
        await this.stop();
        this.dispose();
    }

    public dispose(): void {
        this.status.dispose();
        this.output.dispose();
    }

    private createClient(context: vscode.ExtensionContext): LanguageClient {
        const localServerModule = context.asAbsolutePath(path.join("dist", "server", "main.js"));
        const workspaceServerModule = context.asAbsolutePath(path.join("..", "dist", "server", "main.js"));
        const serverModule = fs.existsSync(localServerModule) ? localServerModule : workspaceServerModule;

        const serverOptions: ServerOptions = {
            run: {
                module: serverModule,
                transport: TransportKind.ipc,
            },
            debug: {
                module: serverModule,
                transport: TransportKind.ipc,
                options: { execArgv: ["--nolazy", "--inspect=6010"] },
            },
        };

        const clientOptions: LanguageClientOptions = {
            documentSelector: [
                { scheme: "file", language: "cora" },
                { scheme: "file", language: "cora.script" },
                { scheme: "file", language: "cora.template" },
            ],
            synchronize: {
                configurationSection: ["corascript"],
                fileEvents: vscode.workspace.createFileSystemWatcher("**/*.{cora,cs,coratmpl}"),
            },
            markdown: {
                isTrusted: false,
                supportHtml: false,
            },
            outputChannel: this.output,
            traceOutputChannel: this.output,
            revealOutputChannelOn: RevealOutputChannelOn.Never,
        };

        return new LanguageClient("corascriptLsp", "CoraScript Language Server", serverOptions, clientOptions);
    }
}
