import * as vscode from "vscode";
import { Trace } from "vscode-languageclient/node";

export function resolveTraceSetting(): Trace {
    const value = String(vscode.workspace.getConfiguration("corascript").get<string>("trace.server", "off"));
    if (value === "messages") {
        return Trace.Messages;
    }
    if (value === "verbose") {
        return Trace.Verbose;
    }
    return Trace.Off;
}
