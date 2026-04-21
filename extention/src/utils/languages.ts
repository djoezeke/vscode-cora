import * as vscode from "vscode";

export const coraLanguageIds = new Set(["cora", "cora.script", "cora.template"]);

export function isCoraDocument(document: vscode.TextDocument | undefined): boolean {
    return !!document && coraLanguageIds.has(document.languageId);
}

export function isCoraEditor(editor: vscode.TextEditor | undefined): boolean {
    return !!editor && isCoraDocument(editor.document);
}
