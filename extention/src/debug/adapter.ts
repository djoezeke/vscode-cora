import { ChildProcess, spawn } from "child_process";

type JsonObject = Record<string, unknown>;

type DebugRequest = {
    seq: number;
    type: "request";
    command: string;
    arguments?: JsonObject;
};

type DebugResponse = {
    type: "response";
    request_seq: number;
    success: boolean;
    command: string;
    seq: number;
    body?: JsonObject;
    message?: string;
};

type DebugEvent = {
    type: "event";
    seq: number;
    event: string;
    body?: JsonObject;
};

class CoraDebugAdapter {
    private sequence = 1;
    private inputBuffer = "";
    private process: ChildProcess | undefined;

    public start(): void {
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk: string | Buffer) => {
            this.inputBuffer += chunk.toString();
            this.processIncomingMessages();
        });
    }

    private processIncomingMessages(): void {
        while (true) {
            const headerEnd = this.inputBuffer.indexOf("\r\n\r\n");
            if (headerEnd < 0) {
                return;
            }

            const header = this.inputBuffer.slice(0, headerEnd);
            const match = header.match(/Content-Length:\s*(\d+)/i);
            if (!match) {
                this.inputBuffer = "";
                return;
            }

            const contentLength = Number(match[1]);
            const bodyStart = headerEnd + 4;
            const bodyEnd = bodyStart + contentLength;
            if (this.inputBuffer.length < bodyEnd) {
                return;
            }

            const raw = this.inputBuffer.slice(bodyStart, bodyEnd);
            this.inputBuffer = this.inputBuffer.slice(bodyEnd);

            let request: DebugRequest;
            try {
                request = JSON.parse(raw) as DebugRequest;
            } catch {
                continue;
            }

            void this.handleRequest(request);
        }
    }

    private async handleRequest(request: DebugRequest): Promise<void> {
        switch (request.command) {
            case "initialize": {
                this.sendResponse(request, {
                    supportsConfigurationDoneRequest: true,
                    supportsTerminateRequest: true,
                    supportsSetVariable: false,
                    supportsRestartRequest: false,
                    supportsEvaluateForHovers: false,
                });
                this.sendEvent("initialized", {});
                return;
            }
            case "launch": {
                await this.handleLaunch(request);
                return;
            }
            case "attach": {
                this.sendResponse(request, {});
                this.sendEvent("thread", { reason: "started", threadId: 1 });
                return;
            }
            case "setBreakpoints": {
                const source = request.arguments?.source as JsonObject | undefined;
                const lines = Array.isArray(request.arguments?.lines) ? request.arguments?.lines : [];
                const breakpoints = (lines as number[]).map((line) => ({
                    verified: false,
                    line,
                    source,
                    message: "Breakpoints are not yet supported by the Cora debug adapter.",
                }));
                this.sendResponse(request, { breakpoints });
                return;
            }
            case "configurationDone":
            case "setExceptionBreakpoints":
            case "pause":
            case "next":
            case "stepIn":
            case "stepOut":
            case "restart": {
                this.sendResponse(request, {});
                return;
            }
            case "threads": {
                this.sendResponse(request, { threads: [{ id: 1, name: "main" }] });
                return;
            }
            case "stackTrace": {
                this.sendResponse(request, { stackFrames: [], totalFrames: 0 });
                return;
            }
            case "scopes": {
                this.sendResponse(request, { scopes: [] });
                return;
            }
            case "variables": {
                this.sendResponse(request, { variables: [] });
                return;
            }
            case "continue": {
                this.sendResponse(request, { allThreadsContinued: true });
                return;
            }
            case "disconnect": {
                if (this.process) {
                    this.process.kill();
                    this.process = undefined;
                }

                this.sendResponse(request, {});
                this.sendEvent("terminated", {});
                this.sendEvent("exited", { exitCode: 0 });
                return;
            }
            default: {
                this.sendResponse(request, {}, false, `Unsupported request: ${request.command}`);
            }
        }
    }

    private async handleLaunch(request: DebugRequest): Promise<void> {
        const args = request.arguments ?? {};
        const program = String(args.program ?? "").trim();
        const interpreterPath = String(args.interpreterPath ?? "cora").trim() || "cora";
        const launchArgs = Array.isArray(args.args) ? (args.args as string[]) : [];
        const cwd = String(args.cwd ?? "").trim() || undefined;

        if (!program) {
            this.sendResponse(request, {}, false, "Missing required launch argument: program");
            return;
        }

        this.process = spawn(interpreterPath, [program, ...launchArgs], {
            cwd,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });

        this.process.stdout?.on("data", (chunk: string | Buffer) => {
            this.sendEvent("output", { category: "stdout", output: chunk.toString() });
        });

        this.process.stderr?.on("data", (chunk: string | Buffer) => {
            this.sendEvent("output", { category: "stderr", output: chunk.toString() });
        });

        this.process.on("error", (error: Error) => {
            this.sendEvent("output", { category: "stderr", output: `${error.message}\n` });
            this.sendEvent("terminated", {});
        });

        this.process.on("exit", (code: number | null) => {
            this.sendEvent("thread", { reason: "exited", threadId: 1 });
            this.sendEvent("exited", { exitCode: code ?? 1 });
            this.sendEvent("terminated", {});
        });

        this.sendResponse(request, {});
        this.sendEvent("process", {
            name: program,
            isLocalProcess: true,
            startMethod: "launch",
            systemProcessId: this.process.pid,
        });
        this.sendEvent("thread", { reason: "started", threadId: 1 });
    }

    private sendResponse(request: DebugRequest, body: JsonObject, success = true, message?: string): void {
        const response: DebugResponse = {
            type: "response",
            request_seq: request.seq,
            success,
            command: request.command,
            seq: this.sequence++,
            body,
        };

        if (message) {
            response.message = message;
        }

        this.writeMessage(response);
    }

    private sendEvent(event: string, body: JsonObject): void {
        const payload: DebugEvent = {
            type: "event",
            seq: this.sequence++,
            event,
            body,
        };

        this.writeMessage(payload);
    }

    private writeMessage(payload: JsonObject): void {
        const body = JSON.stringify(payload);
        process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
    }
}

new CoraDebugAdapter().start();
