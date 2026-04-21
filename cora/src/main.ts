// @ts-nocheck
import * as path from "path";
import {
    CodeAction,
    CodeActionKind,
    CompletionItem,
    CompletionItemKind,
    Connection,
    createConnection,
    Definition,
    Diagnostic,
    DiagnosticSeverity,
    DocumentLink,
    DocumentLinkParams,
    DocumentFormattingParams,
    DocumentRangeFormattingParams,
    DocumentOnTypeFormattingParams,
    DocumentHighlightParams,
    DocumentHighlight,
    DocumentHighlightKind,
    DocumentSymbol,
    Hover,
    HoverParams,
    InitializeParams,
    InitializeResult,
    Location,
    Position,
    Range,
    CodeActionParams,
    CompletionParams,
    DefinitionParams,
    DocumentSymbolParams,
    WorkspaceSymbolParams,
    PrepareRenameParams,
    ReferenceParams,
    RenameParams,
    SemanticTokenModifiers,
    SemanticTokens,
    SemanticTokensBuilder,
    SemanticTokenTypes,
    SignatureHelp,
    SignatureHelpParams,
    SignatureInformation,
    SymbolKind,
    SymbolTag,
    TextDocumentPositionParams,
    InsertTextFormat,
    SemanticTokensParams,
    TextDocuments,
    TextEdit,
    WorkspaceSymbol,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { formatCoraDocument, formatCoraRange } from "./formatter";
import {
    builtinModuleDocs,
    builtinModules,
    createBuiltinBaseItems,
    formatBuiltinModuleMarkdown,
    getBuiltinMemberCompletionItems,
    getBuiltinMemberDoc,
    getBuiltinTopLevelFunctionDoc,
    getMemberAccessContext,
    keywordDocs,
} from "./builtins";
import { resolveModuleDefinition } from "./module";

type CoraSettings = {
    diagnosticsEnabled: boolean;
};

type SymbolInfo = {
    name: string;
    kind: SymbolKind;
    detail?: string;
    containerName?: string;
    range: Range;
    selectionRange: Range;
    location: Location;
    tags?: SymbolTag[];
};

type ParsedDocument = {
    diagnostics: Diagnostic[];
    symbols: SymbolInfo[];
    definitions: Map<string, Location[]>;
    references: Map<string, Location[]>;
    signatureByName: Map<string, SignatureInformation>;
};

const connection: Connection = createConnection();
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

const settingsByUri = new Map<string, CoraSettings>();
const parseCache = new Map<string, ParsedDocument>();
const workspaceRoots: string[] = [];

const builtinItems: CompletionItem[] = createBuiltinBaseItems();

const semanticTokenLegend = {
    tokenTypes: [
        SemanticTokenTypes.class,
        SemanticTokenTypes.function,
        SemanticTokenTypes.variable,
        SemanticTokenTypes.parameter,
        SemanticTokenTypes.keyword,
        SemanticTokenTypes.string,
        SemanticTokenTypes.number,
        SemanticTokenTypes.comment,
        SemanticTokenTypes.type,
        SemanticTokenTypes.namespace,
        SemanticTokenTypes.operator,
    ],
    tokenModifiers: [SemanticTokenModifiers.declaration, SemanticTokenModifiers.readonly],
};

connection.onInitialize((params: InitializeParams): InitializeResult => {
    workspaceRoots.length = 0;
    if (params.workspaceFolders && params.workspaceFolders.length > 0) {
        for (const folder of params.workspaceFolders) {
            workspaceRoots.push(URI.parse(folder.uri).fsPath);
        }
    } else if (params.rootUri) {
        workspaceRoots.push(URI.parse(params.rootUri).fsPath);
    }

    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: documents.syncKind,
            completionProvider: {
                triggerCharacters: [".", ":", "("],
            },
            hoverProvider: true,
            documentSymbolProvider: true,
            workspaceSymbolProvider: true,
            definitionProvider: true,
            referencesProvider: true,
            renameProvider: {
                prepareProvider: true,
            },
            signatureHelpProvider: {
                triggerCharacters: ["(", ","],
            },
            documentFormattingProvider: true,
            documentRangeFormattingProvider: true,
            documentOnTypeFormattingProvider: {
                firstTriggerCharacter: "\n",
                moreTriggerCharacter: ["}", ":"],
            },
            codeActionProvider: true,
            documentHighlightProvider: true,
            documentLinkProvider: {
                resolveProvider: false,
            },
            semanticTokensProvider: {
                legend: semanticTokenLegend,
                full: true,
            },
        },
    };

    return result;
});

connection.onDidChangeConfiguration(() => {
    settingsByUri.clear();
    refreshAllDiagnostics();
});

documents.onDidOpen((event: { document: TextDocument }) => {
    parseCache.delete(event.document.uri);
    publishDiagnostics(event.document);
});

documents.onDidChangeContent((event: { document: TextDocument }) => {
    parseCache.delete(event.document.uri);
    publishDiagnostics(event.document);
});

documents.onDidClose((event: { document: TextDocument }) => {
    parseCache.delete(event.document.uri);
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

connection.onCompletion((params: CompletionParams): CompletionItem[] => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
        return builtinItems;
    }

    const memberContext = getMemberAccessContext(doc, params.position);
    if (memberContext) {
        const memberItems = getBuiltinMemberCompletionItems(memberContext.moduleName);
        if (memberItems.length > 0) {
            return memberItems;
        }
    }

    const parsed = ensureParsed(doc);
    const symbolItems: CompletionItem[] = parsed.symbols.map((symbol) => ({
        label: symbol.name,
        detail: symbol.detail,
        kind: toCompletionKind(symbol.kind),
        documentation: symbol.detail
            ? {
                kind: "markdown",
                value: `**${symbol.name}**\\n\\n${symbol.detail}`,
            }
            : undefined,
    }));

    return [...builtinItems, ...symbolItems];
});

connection.onHover((params: HoverParams): Hover | null => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        return null;
    }

    const word = getWordAtPosition(document, params.position);
    if (!word) {
        return null;
    }

    const keywordDoc = keywordDocs.get(word.text);
    if (keywordDoc) {
        return {
            contents: {
                kind: "markdown",
                value: `**${word.text}**\\n\\n${keywordDoc}`,
            },
            range: word.range,
        };
    }

    const memberContext = getMemberAccessContext(document, word.range.start);
    if (memberContext) {
        const builtinMember = getBuiltinMemberDoc(memberContext.moduleName, word.text);
        if (builtinMember) {
            return {
                contents: {
                    kind: "markdown",
                    value: `**${memberContext.moduleName}.${builtinMember.name}**\\n\\n\`${builtinMember.signature}\`\\n\\n${builtinMember.documentation}`,
                },
                range: word.range,
            };
        }
    }

    const builtinModule = builtinModuleDocs.get(word.text);
    if (builtinModule) {
        return {
            contents: {
                kind: "markdown",
                value: formatBuiltinModuleMarkdown(builtinModule),
            },
            range: word.range,
        };
    }

    const builtinTopLevel = getBuiltinTopLevelFunctionDoc(word.text);
    if (builtinTopLevel) {
        return {
            contents: {
                kind: "markdown",
                value: `**${builtinTopLevel.name}**\\n\\n\`${builtinTopLevel.signature}\`\\n\\n${builtinTopLevel.documentation}`,
            },
            range: word.range,
        };
    }

    const parsed = ensureParsed(document);
    const symbol = parsed.symbols.find((entry) => entry.name === word.text);
    if (!symbol) {
        return null;
    }

    return {
        contents: {
            kind: "markdown",
            value: `**${symbol.name}**${symbol.detail ? `\\n\\n${symbol.detail}` : ""}`,
        },
        range: word.range,
    };
});

connection.onDocumentSymbol((params: DocumentSymbolParams): DocumentSymbol[] => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
        return [];
    }

    const parsed = ensureParsed(doc);
    const classNodes = new Map<string, DocumentSymbol>();
    const roots: DocumentSymbol[] = [];

    for (const symbol of parsed.symbols) {
        const node: DocumentSymbol = {
            name: symbol.name,
            kind: symbol.kind,
            detail: symbol.detail,
            range: symbol.range,
            selectionRange: symbol.selectionRange,
            tags: symbol.tags,
            children: [],
        };

        if (symbol.kind === SymbolKind.Class) {
            classNodes.set(symbol.name, node);
            roots.push(node);
            continue;
        }

        if (symbol.containerName && classNodes.has(symbol.containerName)) {
            classNodes.get(symbol.containerName)?.children?.push(node);
        } else {
            roots.push(node);
        }
    }

    return roots;
});

connection.onWorkspaceSymbol((params: WorkspaceSymbolParams): WorkspaceSymbol[] => {
    const query = params.query.toLowerCase();
    const items: WorkspaceSymbol[] = [];

    for (const parsed of parseCache.values()) {
        for (const symbol of parsed.symbols) {
            if (!symbol.name.toLowerCase().includes(query)) {
                continue;
            }

            items.push({
                name: symbol.name,
                kind: symbol.kind,
                location: symbol.location,
                tags: symbol.tags,
                containerName: symbol.containerName,
            });
        }
    }

    return items;
});

connection.onDefinition((params: DefinitionParams): Definition | null => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
        return null;
    }

    const word = getWordAtPosition(doc, params.position);
    if (!word) {
        return null;
    }

    const moduleTarget = resolveModuleDefinition(doc, params.position, word.text, workspaceRoots, builtinModuleDocs);
    if (moduleTarget) {
        return [moduleTarget];
    }

    const locations = collectDefinitionLocations(word.text);
    if (locations.length === 0) {
        return null;
    }

    return locations;
});

connection.onReferences((params: ReferenceParams): Location[] => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
        return [];
    }

    const word = getWordAtPosition(doc, params.position);
    if (!word) {
        return [];
    }

    return collectReferenceLocations(word.text);
});

connection.onPrepareRename((params: PrepareRenameParams): Range | null => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
        return null;
    }

    const word = getWordAtPosition(doc, params.position);
    if (!word) {
        return null;
    }

    return word.range;
});

connection.onRenameRequest((params: RenameParams) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
        return null;
    }

    const word = getWordAtPosition(doc, params.position);
    if (!word) {
        return null;
    }

    const references = collectReferenceLocations(word.text);
    const changes: Record<string, TextEdit[]> = {};

    for (const ref of references) {
        if (!changes[ref.uri]) {
            changes[ref.uri] = [];
        }

        changes[ref.uri].push({ range: ref.range, newText: params.newName });
    }

    return { changes };
});

connection.onSignatureHelp((params: SignatureHelpParams): SignatureHelp | null => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
        return null;
    }

    const triggerWord = getInvocationName(doc, params.position);
    if (!triggerWord) {
        return null;
    }

    const signatures = collectSignatures(triggerWord);
    if (signatures.length === 0) {
        return null;
    }

    return {
        signatures,
        activeSignature: 0,
        activeParameter: 0,
    };
});

connection.onDocumentFormatting((params: DocumentFormattingParams): TextEdit[] => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        return [];
    }

    const original = document.getText();
    const formatted = formatCoraDocument(original, {
        indentToken: params.options.insertSpaces ? " ".repeat(params.options.tabSize) : "\t",
    });
    if (formatted === original) {
        return [];
    }

    return [
        {
            range: Range.create(
                Position.create(0, 0),
                document.positionAt(original.length),
            ),
            newText: formatted,
        },
    ];
});

connection.onDocumentRangeFormatting((params: DocumentRangeFormattingParams): TextEdit[] => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        return [];
    }

    const originalText = document.getText();
    const replacement = formatCoraRange(
        originalText,
        params.range.start.line,
        params.range.end.line,
        {
            indentToken: params.options.insertSpaces ? " ".repeat(params.options.tabSize) : "\t",
        },
    );

    const originalRangeText = document.getText(params.range);
    if (replacement === originalRangeText) {
        return [];
    }

    return [{ range: params.range, newText: replacement }];
});

connection.onDocumentOnTypeFormatting((params: DocumentOnTypeFormattingParams): TextEdit[] => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        return [];
    }

    const line = params.position.line;
    const lastLine = Math.max(0, document.lineCount - 1);
    const startLine = Math.max(0, line - 1);
    const endLine = Math.min(lastLine, line + 1);
    const start = Position.create(startLine, 0);
    const end = Position.create(endLine, document.getText().split(/\r?\n/)[endLine]?.length ?? 0);
    const range = Range.create(start, end);

    const replacement = formatCoraRange(
        document.getText(),
        startLine,
        endLine,
        {
            indentToken: params.options.insertSpaces ? " ".repeat(params.options.tabSize) : "\t",
        },
    );

    const originalRangeText = document.getText(range);
    if (replacement === originalRangeText) {
        return [];
    }

    return [{ range, newText: replacement }];
});

connection.onCodeAction((params: CodeActionParams): CodeAction[] => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
        return [];
    }

    const actions: CodeAction[] = [];
    const imports = collectImports(doc);
    const sorted = [...imports].sort((a, b) => a.module.localeCompare(b.module));

    if (imports.length > 1 && !imports.every((entry, index) => entry.module === sorted[index].module)) {
        const start = imports[0].range.start;
        const end = imports[imports.length - 1].range.end;

        actions.push({
            title: "Sort imports",
            kind: CodeActionKind.SourceOrganizeImports,
            edit: {
                changes: {
                    [doc.uri]: [
                        {
                            range: Range.create(start, end),
                            newText: sorted.map((item) => `import ${item.module}`).join("\n"),
                        },
                    ],
                },
            },
        });
    }

    if (params.context.diagnostics.some((d: Diagnostic) => d.message.includes("Unmatched closing"))) {
        actions.push({
            title: "Remove unmatched closing bracket",
            kind: CodeActionKind.QuickFix,
        });
    }

    return actions;
});

connection.onDocumentHighlight((params: DocumentHighlightParams): DocumentHighlight[] => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
        return [];
    }

    const word = getWordAtPosition(doc, params.position);
    if (!word) {
        return [];
    }

    return collectReferenceLocations(word.text)
        .filter((location) => location.uri === doc.uri)
        .map((location) => ({
            range: location.range,
            kind: DocumentHighlightKind.Text,
        }));
});

connection.onDocumentLinks((params: DocumentLinkParams): DocumentLink[] => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        return [];
    }

    const links: DocumentLink[] = [];
    const imports = collectImports(document);
    const openDocumentUris = new Map<string, string>();

    for (const openDoc of documents.all()) {
        const baseName = path.posix.basename(URI.parse(openDoc.uri).path);
        openDocumentUris.set(baseName, openDoc.uri);
    }

    for (const imported of imports) {
        const candidates = [`${imported.module}.cora`, `${imported.module}.cs`, `${imported.module}.coratmpl`];
        const target = candidates.map((name) => openDocumentUris.get(name)).find((uri) => !!uri);
        if (!target) {
            continue;
        }

        const line = document.getText(imported.range);
        const moduleStart = Math.max(0, line.indexOf(imported.module));

        links.push({
            range: Range.create(
                Position.create(imported.range.start.line, moduleStart),
                Position.create(imported.range.start.line, moduleStart + imported.module.length),
            ),
            target,
            tooltip: `Open ${imported.module}`,
        });
    }

    return links;
});

connection.languages.semanticTokens.on((params: SemanticTokensParams): SemanticTokens => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
        return { data: [] };
    }

    return buildSemanticTokens(doc);
});

async function getDocumentSettings(resource: string): Promise<CoraSettings> {
    if (settingsByUri.has(resource)) {
        return settingsByUri.get(resource)!;
    }

    const settings = await connection.workspace.getConfiguration({
        scopeUri: resource,
        section: "corascript",
    });

    const resolved: CoraSettings = {
        diagnosticsEnabled: Boolean(settings?.diagnostics?.enabled ?? true),
    };

    settingsByUri.set(resource, resolved);
    return resolved;
}

async function refreshAllDiagnostics(): Promise<void> {
    for (const document of documents.all()) {
        await publishDiagnostics(document);
    }
}

async function publishDiagnostics(document: TextDocument): Promise<void> {
    const settings = await getDocumentSettings(document.uri);
    const parsed = ensureParsed(document);
    connection.sendDiagnostics({
        uri: document.uri,
        diagnostics: settings.diagnosticsEnabled ? parsed.diagnostics : [],
    });
}

function ensureParsed(document: TextDocument): ParsedDocument {
    const cached = parseCache.get(document.uri);
    if (cached) {
        return cached;
    }

    const parsed = parseDocument(document);
    parseCache.set(document.uri, parsed);
    return parsed;
}

function parseDocument(document: TextDocument): ParsedDocument {
    const text = document.getText();
    const sanitizedText = stripBlockCommentSegments(text);
    const lines = sanitizedText.split(/\r?\n/);
    const diagnostics: Diagnostic[] = [];
    const symbols: SymbolInfo[] = [];
    const definitions = new Map<string, Location[]>();
    const references = new Map<string, Location[]>();
    const signatureByName = new Map<string, SignatureInformation>();
    const importedModules: Array<{ module: string; range: Range }> = [];

    const stack: Array<{ token: string; position: Position }> = [];
    const duplicateFnTracker = new Set<string>();
    let currentClass: { name: string; indent: number; braceDepth: number } | null = null;
    let braceDepth = 0;

    const addDefinition = (name: string, location: Location) => {
        const items = definitions.get(name) ?? [];
        items.push(location);
        definitions.set(name, items);
    };

    const addReference = (name: string, location: Location) => {
        const items = references.get(name) ?? [];
        items.push(location);
        references.set(name, items);
    };

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        const stripped = stripStringAndCommentSegments(line);

        const leading = line.match(/^\s*/)?.[0].length ?? 0;
        if (currentClass && currentClass.braceDepth === 0 && leading <= currentClass.indent && line.trim().length > 0 && !line.trim().startsWith("{")) {
            currentClass = null;
        }

        for (let charIndex = 0; charIndex < stripped.length; charIndex += 1) {
            const char = stripped[charIndex];
            if (char === "{" || char === "(" || char === "[") {
                stack.push({ token: char, position: Position.create(lineIndex, charIndex) });
            }

            if (char === "}" || char === ")" || char === "]") {
                const open = stack.pop();
                if (!open || !isMatchingBracket(open.token, char)) {
                    diagnostics.push({
                        severity: DiagnosticSeverity.Error,
                        range: Range.create(
                            Position.create(lineIndex, charIndex),
                            Position.create(lineIndex, charIndex + 1),
                        ),
                        message: `Unmatched closing '${char}'.`,
                        source: "cora-lsp",
                    });
                }
            }
        }

        const classMatch = line.match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (classMatch) {
            const name = classMatch[1];
            const start = Position.create(lineIndex, line.indexOf(name));
            const end = Position.create(lineIndex, line.indexOf(name) + name.length);
            const range = Range.create(start, end);
            const location = Location.create(document.uri, range);
            symbols.push({
                name,
                kind: SymbolKind.Class,
                detail: "class",
                range,
                selectionRange: range,
                location,
            });
            addDefinition(name, location);
            currentClass = {
                name,
                indent: leading,
                braceDepth,
            };
        }

        const funMatch = line.match(/^\s*(?:pub\s+)?fun\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?:->\s*([A-Za-z_][A-Za-z0-9_]*))?/);
        if (funMatch) {
            const name = funMatch[1];
            const paramsText = funMatch[2].trim();
            const returnType = funMatch[3];
            const params: string[] =
                paramsText.length === 0
                    ? []
                    : paramsText
                        .split(",")
                        .map((item: string) => item.trim())
                        .filter((item: string) => item.length > 0);
            const signatureLabel = `${name}(${params.join(", ")})${returnType ? ` -> ${returnType}` : ""}`;
            signatureByName.set(
                name,
                SignatureInformation.create(signatureLabel, undefined, ...params.map((param: string) => ({ label: param }))),
            );

            const duplicateKey = `${currentClass?.name ?? "global"}:${name}:${params.length}`;
            if (duplicateFnTracker.has(duplicateKey)) {
                const nameOffset = line.indexOf(name);
                diagnostics.push({
                    severity: DiagnosticSeverity.Warning,
                    range: Range.create(
                        Position.create(lineIndex, nameOffset),
                        Position.create(lineIndex, nameOffset + name.length),
                    ),
                    message: `Duplicate function overload '${name}' with ${params.length} parameter(s).`,
                    source: "cora-lsp",
                });
            }
            duplicateFnTracker.add(duplicateKey);

            const start = Position.create(lineIndex, line.indexOf(name));
            const end = Position.create(lineIndex, line.indexOf(name) + name.length);
            const range = Range.create(start, end);
            const location = Location.create(document.uri, range);
            symbols.push({
                name,
                kind: SymbolKind.Function,
                detail: signatureLabel,
                containerName: currentClass?.name,
                range,
                selectionRange: range,
                location,
            });
            addDefinition(name, location);
        }

        const importMatch = line.match(/^\s*import\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (importMatch) {
            const name = importMatch[1];
            const start = Position.create(lineIndex, line.indexOf(name));
            const end = Position.create(lineIndex, line.indexOf(name) + name.length);
            const range = Range.create(start, end);
            const location = Location.create(document.uri, range);
            symbols.push({
                name,
                kind: SymbolKind.Module,
                detail: "import",
                range,
                selectionRange: range,
                location,
            });
            importedModules.push({ module: name, range });
            addDefinition(name, location);
        }

        const variableRegex = /\b(?:pub\s+)?(?:let|const)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
        for (const match of line.matchAll(variableRegex)) {
            const name = match[1];
            const index = match.index ?? 0;
            const nameOffset = line.indexOf(name, index);
            const start = Position.create(lineIndex, nameOffset);
            const end = Position.create(lineIndex, nameOffset + name.length);
            const range = Range.create(start, end);
            const location = Location.create(document.uri, range);
            symbols.push({
                name,
                kind: SymbolKind.Variable,
                detail: "variable",
                containerName: currentClass?.name,
                range,
                selectionRange: range,
                location,
            });
            addDefinition(name, location);
        }

        for (const match of line.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
            const name = match[0];
            const start = Position.create(lineIndex, match.index ?? 0);
            const end = Position.create(lineIndex, (match.index ?? 0) + name.length);
            addReference(name, Location.create(document.uri, Range.create(start, end)));
        }

        braceDepth += (stripped.match(/{/g)?.length ?? 0) - (stripped.match(/}/g)?.length ?? 0);
        if (currentClass && braceDepth < currentClass.braceDepth) {
            currentClass = null;
        }
    }

    for (const open of stack) {
        diagnostics.push({
            severity: DiagnosticSeverity.Error,
            range: Range.create(open.position, Position.create(open.position.line, open.position.character + 1)),
            message: `Unmatched opening '${open.token}'.`,
            source: "cora-lsp",
        });
    }

    const discoveredModules = new Set<string>();
    for (const openDoc of documents.all()) {
        const baseName = path.posix.basename(URI.parse(openDoc.uri).path);
        const moduleName = baseName.replace(/\.(cora|cs|coratmpl)$/i, "");
        if (moduleName.length > 0) {
            discoveredModules.add(moduleName);
        }
    }

    for (const imported of importedModules) {
        if (builtinModules.has(imported.module) || discoveredModules.has(imported.module)) {
            continue;
        }

        diagnostics.push({
            severity: DiagnosticSeverity.Warning,
            range: imported.range,
            message: `Unknown module '${imported.module}'.`,
            source: "cora-lsp",
        });
    }

    return {
        diagnostics,
        symbols,
        definitions,
        references,
        signatureByName,
    };
}

function stripStringAndCommentSegments(line: string): string {
    return line
        .replace(/"(?:\\.|[^"\\])*"/g, '""')
        .replace(/'(?:\\.|[^'\\])*'/g, "''")
        .replace(/\/\/.*$/, "")
        .replace(/#.*$/, "");
}

function stripBlockCommentSegments(text: string): string {
    let output = "";
    let inComment = false;

    for (let index = 0; index < text.length; index += 1) {
        const current = text[index];
        const next = index + 1 < text.length ? text[index + 1] : "";

        if (!inComment && current === "/" && next === "*") {
            output += "  ";
            index += 1;
            inComment = true;
            continue;
        }

        if (inComment && current === "*" && next === "/") {
            output += "  ";
            index += 1;
            inComment = false;
            continue;
        }

        if (inComment) {
            output += current === "\n" || current === "\r" ? current : " ";
            continue;
        }

        output += current;
    }

    return output;
}

function isMatchingBracket(open: string, close: string): boolean {
    return (open === "{" && close === "}") || (open === "(" && close === ")") || (open === "[" && close === "]");
}

function toCompletionKind(kind: SymbolKind): CompletionItemKind {
    switch (kind) {
        case SymbolKind.Class:
            return CompletionItemKind.Class;
        case SymbolKind.Function:
            return CompletionItemKind.Function;
        case SymbolKind.Module:
            return CompletionItemKind.Module;
        case SymbolKind.Variable:
            return CompletionItemKind.Variable;
        default:
            return CompletionItemKind.Text;
    }
}

function getWordAtPosition(document: TextDocument, position: Position): { text: string; range: Range } | null {
    const text = document.getText();
    const offset = document.offsetAt(position);

    if (offset < 0 || offset >= text.length) {
        return null;
    }

    const isWord = (char: string) => /[A-Za-z0-9_]/.test(char);
    let start = offset;
    let end = offset;

    if (!isWord(text[offset])) {
        return null;
    }

    while (start > 0 && isWord(text[start - 1])) {
        start -= 1;
    }

    while (end < text.length && isWord(text[end])) {
        end += 1;
    }

    return {
        text: text.slice(start, end),
        range: Range.create(document.positionAt(start), document.positionAt(end)),
    };
}

function collectDefinitionLocations(name: string): Location[] {
    const all: Location[] = [];
    for (const parsed of parseCache.values()) {
        const locations = parsed.definitions.get(name);
        if (locations) {
            all.push(...locations);
        }
    }
    return all;
}

function collectReferenceLocations(name: string): Location[] {
    const all: Location[] = [];
    for (const parsed of parseCache.values()) {
        const locations = parsed.references.get(name);
        if (locations) {
            all.push(...locations);
        }
    }
    return all;
}

function collectSignatures(name: string): SignatureInformation[] {
    const signatures: SignatureInformation[] = [];
    for (const parsed of parseCache.values()) {
        const sig = parsed.signatureByName.get(name);
        if (sig) {
            signatures.push(sig);
        }
    }
    return signatures;
}

function getInvocationName(document: TextDocument, position: Position): string | null {
    const text = document.getText();
    const offset = document.offsetAt(position);
    const before = text.slice(0, offset);
    const match = before.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\([^()]*$/);
    return match ? match[1] : null;
}

function collectImports(document: TextDocument): Array<{ module: string; range: Range }> {
    const lines = stripBlockCommentSegments(document.getText()).split(/\r?\n/);
    const imports: Array<{ module: string; range: Range }> = [];

    for (let line = 0; line < lines.length; line += 1) {
        const match = lines[line].match(/^\s*import\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (!match) {
            continue;
        }

        const module = match[1];
        const start = Position.create(line, 0);
        const end = Position.create(line, lines[line].length);
        imports.push({ module, range: Range.create(start, end) });
    }

    return imports;
}

function buildSemanticTokens(document: TextDocument): SemanticTokens {
    const builder = new SemanticTokensBuilder();
    const sourceText = document.getText();
    const lines = sourceText.split(/\r?\n/);
    const strippedLines = stripBlockCommentSegments(sourceText).split(/\r?\n/);
    const keywordRegex = /\b(class|fun|import|let|const|pub|if|else|while|for|return|break|continue|and|or|not|this)\b/g;
    const typeRegex = /\b(int|float|str|string|bool|void|job)\b/g;
    const numberRegex = /\b\d+(?:\.\d+)?\b/g;
    const operatorRegex = /\+|-|\*|\/|%|==|!=|<=|>=|<|>|=|->|:/g;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        const strippedLine = strippedLines[lineIndex] ?? line;

        for (const match of strippedLine.matchAll(/\/\/.*$|#.*$/g)) {
            if (match.index !== undefined) {
                builder.push(lineIndex, match.index, match[0].length, semanticTokenLegend.tokenTypes.indexOf(SemanticTokenTypes.comment), 0);
            }
        }

        for (const match of line.matchAll(/\/\*[^]*?\*\//g)) {
            if (match.index !== undefined) {
                builder.push(lineIndex, match.index, match[0].length, semanticTokenLegend.tokenTypes.indexOf(SemanticTokenTypes.comment), 0);
            }
        }

        for (const match of line.matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g)) {
            if (match.index !== undefined) {
                builder.push(lineIndex, match.index, match[0].length, semanticTokenLegend.tokenTypes.indexOf(SemanticTokenTypes.string), 0);
            }
        }

        for (const match of line.matchAll(numberRegex)) {
            if (match.index !== undefined) {
                builder.push(lineIndex, match.index, match[0].length, semanticTokenLegend.tokenTypes.indexOf(SemanticTokenTypes.number), 0);
            }
        }

        for (const match of line.matchAll(keywordRegex)) {
            if (match.index !== undefined) {
                builder.push(lineIndex, match.index, match[0].length, semanticTokenLegend.tokenTypes.indexOf(SemanticTokenTypes.keyword), 0);
            }
        }

        for (const match of line.matchAll(typeRegex)) {
            if (match.index !== undefined) {
                builder.push(lineIndex, match.index, match[0].length, semanticTokenLegend.tokenTypes.indexOf(SemanticTokenTypes.type), 0);
            }
        }

        for (const match of line.matchAll(operatorRegex)) {
            if (match.index !== undefined) {
                builder.push(lineIndex, match.index, match[0].length, semanticTokenLegend.tokenTypes.indexOf(SemanticTokenTypes.operator), 0);
            }
        }

        const classMatch = line.match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (classMatch) {
            const name = classMatch[1];
            const index = line.indexOf(name);
            builder.push(lineIndex, index, name.length, semanticTokenLegend.tokenTypes.indexOf(SemanticTokenTypes.class), semanticTokenLegend.tokenModifiers.indexOf(SemanticTokenModifiers.declaration));
        }

        const funMatch = line.match(/^\s*(?:pub\s+)?fun\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (funMatch) {
            const name = funMatch[1];
            const index = line.indexOf(name);
            builder.push(lineIndex, index, name.length, semanticTokenLegend.tokenTypes.indexOf(SemanticTokenTypes.function), semanticTokenLegend.tokenModifiers.indexOf(SemanticTokenModifiers.declaration));
        }

        const importMatch = line.match(/^\s*import\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (importMatch) {
            const name = importMatch[1];
            const index = line.indexOf(name);
            builder.push(lineIndex, index, name.length, semanticTokenLegend.tokenTypes.indexOf(SemanticTokenTypes.namespace), 0);
        }

        for (const match of line.matchAll(/\b(?:pub\s+)?(?:let|const)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
            const name = match[1];
            const idx = line.indexOf(name, match.index ?? 0);
            builder.push(lineIndex, idx, name.length, semanticTokenLegend.tokenTypes.indexOf(SemanticTokenTypes.variable), semanticTokenLegend.tokenModifiers.indexOf(SemanticTokenModifiers.declaration));
        }
    }

    return builder.build();
}

documents.listen(connection);
connection.listen();
