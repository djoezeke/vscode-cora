// @ts-nocheck
import * as fs from "fs";
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
    FileChangeType,
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
    InlayHint,
    InlayHintKind,
    InlayHintParams,
    Location,
    Position,
    Range,
    CodeActionParams,
    CodeActionTriggerKind,
    Command,
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
    WorkspaceEdit,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { formatCoraDocument, formatCoraRange } from "./formatter";
import {
    formatBinding,
    formatDeclarationLabel,
    formatFunctionSignature,
    inferExpressionType,
    parseDeclaration,
    parseParameterList,
    splitTopLevelItems,
} from "./language/analysis";
import { codeBlock, joinMarkdownSections } from "./language/markdown";
import {
    builtinTopLevelFunctions,
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
    indexMaxFiles: number;
    indexExclude: string[];
};

type SymbolInfo = {
    name: string;
    kind: SymbolKind;
    detail?: string;
    typeName?: string;
    declaredTypeName?: string;
    signature?: string;
    declaration?: string;
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
const workspaceIndexedUris = new Set<string>();
let workspaceIndexReady = false;
let globalSettings: CoraSettings = {
    diagnosticsEnabled: true,
    indexMaxFiles: 2000,
    indexExclude: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/out/**"],
};

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
            typeDefinitionProvider: true,
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
            inlayHintProvider: true,
        },
    };

    return result;
});

connection.onDidChangeConfiguration(() => {
    settingsByUri.clear();
    globalSettings = {
        diagnosticsEnabled: true,
        indexMaxFiles: 2000,
        indexExclude: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/out/**"],
    };
    workspaceIndexReady = false;
    void refreshGlobalSettings().then(() => rebuildWorkspaceIndex());
    refreshAllDiagnostics();
});

documents.onDidOpen((event: { document: TextDocument }) => {
    invalidateDocumentCache(event.document.uri);
    publishDiagnostics(event.document);
});

documents.onDidChangeContent((event: { document: TextDocument }) => {
    invalidateDocumentCache(event.document.uri);
    publishDiagnostics(event.document);
});

documents.onDidClose((event: { document: TextDocument }) => {
    invalidateDocumentCache(event.document.uri);
    if (workspaceIndexedUris.has(event.document.uri)) {
        indexUriFromDisk(event.document.uri);
    }
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

connection.onInitialized(() => {
    void refreshGlobalSettings().then(() => rebuildWorkspaceIndex());
});

connection.onDidChangeWatchedFiles((params) => {
    handleWatchedFilesChanged(params);
});

connection.onCompletion((params: CompletionParams): CompletionItem[] => {
    ensureWorkspaceIndexInitialized();
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
        return [...builtinItems, ...buildWorkspaceCompletionItems()];
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
                value: joinMarkdownSections(`**${symbol.name}**`, codeBlock("cora", symbol.detail)),
            }
            : undefined,
    }));

    return dedupeCompletionItems([...builtinItems, ...symbolItems, ...buildWorkspaceCompletionItems()]);
});

connection.onHover((params: HoverParams): Hover | null => {
    ensureWorkspaceIndexInitialized();
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
                value: joinMarkdownSections(`**${word.text}**`, keywordDoc),
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
                    value: joinMarkdownSections(
                        `**${memberContext.moduleName}.${builtinMember.name}**`,
                        codeBlock("cora", builtinMember.signature),
                        builtinMember.documentation,
                    ),
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
                value: joinMarkdownSections(
                    `**${builtinTopLevel.name}**`,
                    codeBlock("cora", builtinTopLevel.signature),
                    builtinTopLevel.documentation,
                ),
            },
            range: word.range,
        };
    }

    const parsed = ensureParsed(document);
    const symbol = findBestSymbol(parsed.symbols, word.text) ?? findBestWorkspaceSymbol(word.text);
    if (!symbol) {
        return null;
    }

    return {
        contents: {
            kind: "markdown",
            value: formatSymbolHoverMarkdown(symbol),
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
    ensureWorkspaceIndexInitialized();
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
    ensureWorkspaceIndexInitialized();
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

connection.onTypeDefinition((params): Definition | null => {
    ensureWorkspaceIndexInitialized();
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
        return null;
    }

    const symbolAtCursor = findSymbolAtPosition(ensureParsed(doc).symbols, params.position);
    const target = symbolAtCursor ?? (() => {
        const word = getWordAtPosition(doc, params.position);
        if (!word) {
            return null;
        }

        return findBestWorkspaceSymbol(word.text);
    })();

    if (!target) {
        return null;
    }

    const declaredType = resolveDeclaredTypeTarget(target);
    if (!declaredType) {
        return null;
    }

    const locations = collectDefinitionLocations(declaredType);
    return locations.length > 0 ? locations : null;
});

connection.onReferences((params: ReferenceParams): Location[] => {
    ensureWorkspaceIndexInitialized();
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

connection.languages.inlayHint.on((params: InlayHintParams): InlayHint[] => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
        return [];
    }

    const parsed = ensureParsed(doc);
    const hints: InlayHint[] = [];

    for (const symbol of parsed.symbols) {
        if (symbol.kind === SymbolKind.Variable && symbol.typeName && !symbol.declaredTypeName && rangeContains(params.range, symbol.range.start)) {
            hints.push({
                position: symbol.range.end,
                label: `: ${symbol.typeName}`,
                kind: InlayHintKind.Type,
                paddingLeft: true,
            });
        }

        if (symbol.kind === SymbolKind.Function && symbol.typeName && rangeContains(params.range, symbol.range.end)) {
            hints.push({
                position: symbol.range.end,
                label: ` -> ${symbol.typeName}`,
                kind: InlayHintKind.Type,
                paddingLeft: true,
            });
        }
    }

    hints.push(...buildParameterNameInlayHints(doc, params.range));
    return hints;
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
    ensureWorkspaceIndexInitialized();
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
    ensureWorkspaceIndexInitialized();
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
        return [];
    }

    const actions: CodeAction[] = [];
    const imports = collectImports(doc);
    const unusedImports = collectUnusedImports(doc, imports);
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

    if (unusedImports.length > 0) {
        actions.push({
            title: "Remove unused imports",
            kind: CodeActionKind.QuickFix,
            diagnostics: params.context.diagnostics.filter((d) => d.message.includes("Unused import")),
            edit: {
                changes: {
                    [doc.uri]: unusedImports
                        .sort((left, right) => {
                            if (left.range.start.line !== right.range.start.line) {
                                return right.range.start.line - left.range.start.line;
                            }

                            return right.range.start.character - left.range.start.character;
                        })
                        .map((item) => ({
                            range: Range.create(
                                Position.create(item.range.start.line, 0),
                                Position.create(item.range.end.line + 1, 0),
                            ),
                            newText: "",
                        })),
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

    const wantsExtractRefactor = params.context.triggerKind === CodeActionTriggerKind.Invoked
        && params.context.diagnostics.length === 0
        && (
            !params.context.only
            || params.context.only.some((kind) => kind.startsWith(CodeActionKind.Refactor))
        );
    const selectedText = wantsExtractRefactor ? doc.getText(params.range) : "";
    if (selectedText.trim().length > 0) {
        const extractVar = buildExtractVariableAction(doc, params.range, selectedText);
        if (extractVar) {
            actions.push(extractVar);
        }

        const extractMethod = buildExtractMethodAction(doc, params.range, selectedText);
        if (extractMethod) {
            actions.push(extractMethod);
        }
    }

    const importActions = buildAutoImportActions(doc, params);
    actions.push(...importActions);

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
    const availableUris = new Map<string, string>();

    for (const uri of parseCache.keys()) {
        const baseName = path.posix.basename(URI.parse(uri).path);
        availableUris.set(baseName, uri);
    }

    for (const imported of imports) {
        const candidates = [`${imported.module}.cora`, `${imported.module}.cs`, `${imported.module}.coratmpl`];
        const target = candidates.map((name) => availableUris.get(name)).find((uri) => !!uri);
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
        diagnosticsEnabled: Boolean(settings?.diagnostics?.enabled ?? globalSettings.diagnosticsEnabled),
        indexMaxFiles: Number(settings?.index?.maxFiles ?? globalSettings.indexMaxFiles),
        indexExclude: Array.isArray(settings?.index?.exclude)
            ? settings.index.exclude.map((item: unknown) => String(item))
            : [...globalSettings.indexExclude],
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

async function refreshGlobalSettings(): Promise<void> {
    const settings = await connection.workspace.getConfiguration({ section: "corascript" });
    globalSettings = {
        diagnosticsEnabled: Boolean(settings?.diagnostics?.enabled ?? true),
        indexMaxFiles: Number(settings?.index?.maxFiles ?? 2000),
        indexExclude: Array.isArray(settings?.index?.exclude)
            ? settings.index.exclude.map((entry: unknown) => String(entry))
            : ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/out/**"],
    };
}

function invalidateDocumentCache(uri: string): void {
    parseCache.delete(uri);
}

function ensureWorkspaceIndexInitialized(): void {
    if (workspaceIndexReady) {
        return;
    }

    rebuildWorkspaceIndex();
}

function rebuildWorkspaceIndex(): void {
    const discoveredUris = collectWorkspaceDocumentUris();
    const seen = new Set(discoveredUris);

    for (const uri of workspaceIndexedUris) {
        if (!seen.has(uri) && !documents.get(uri)) {
            parseCache.delete(uri);
        }
    }

    workspaceIndexedUris.clear();
    for (const uri of discoveredUris) {
        workspaceIndexedUris.add(uri);
        if (!documents.get(uri)) {
            indexUriFromDisk(uri);
        }
    }

    workspaceIndexReady = true;
    refreshAllDiagnostics();
}

function handleWatchedFilesChanged(params): void {
    for (const change of params.changes) {
        const uri = change.uri;
        if (!isCoraUri(uri)) {
            continue;
        }

        if (change.type === FileChangeType.Deleted) {
            workspaceIndexedUris.delete(uri);
            if (!documents.get(uri)) {
                parseCache.delete(uri);
            }
            continue;
        }

        workspaceIndexedUris.add(uri);
        if (!documents.get(uri)) {
            indexUriFromDisk(uri);
        }
    }

    refreshAllDiagnostics();
}

function indexUriFromDisk(uri: string): void {
    try {
        const filePath = URI.parse(uri).fsPath;
        if (!fs.existsSync(filePath)) {
            parseCache.delete(uri);
            return;
        }

        const source = fs.readFileSync(filePath, "utf-8");
        const languageId = getLanguageIdFromPath(filePath);
        const document = TextDocument.create(uri, languageId, 0, source);
        parseCache.set(uri, parseDocument(document));
    } catch {
        parseCache.delete(uri);
    }
}

function collectWorkspaceDocumentUris(): string[] {
    const results: string[] = [];
    const maxFiles = Math.max(100, globalSettings.indexMaxFiles || 2000);

    for (const root of workspaceRoots) {
        if (!fs.existsSync(root)) {
            continue;
        }

        const stack = [root];
        while (stack.length > 0 && results.length < maxFiles) {
            const current = stack.pop();
            if (!current) {
                continue;
            }

            let entries: fs.Dirent[] = [];
            try {
                entries = fs.readdirSync(current, { withFileTypes: true });
            } catch {
                continue;
            }

            for (const entry of entries) {
                const fullPath = path.join(current, entry.name);
                const relativePath = normalizePath(path.relative(root, fullPath));
                if (shouldExcludeWorkspacePath(relativePath, globalSettings.indexExclude)) {
                    continue;
                }

                if (entry.isDirectory()) {
                    stack.push(fullPath);
                    continue;
                }

                if (!isCoraPath(fullPath)) {
                    continue;
                }

                results.push(URI.file(fullPath).toString());
                if (results.length >= maxFiles) {
                    break;
                }
            }
        }

        if (results.length >= maxFiles) {
            break;
        }
    }

    return results;
}

function shouldExcludeWorkspacePath(relativePath: string, patterns: string[]): boolean {
    if (!relativePath || relativePath === ".") {
        return false;
    }

    return patterns.some((pattern) => globToRegExp(pattern).test(relativePath));
}

function globToRegExp(pattern: string): RegExp {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "::DOUBLE_STAR::")
        .replace(/\*/g, "[^/]*")
        .replace(/::DOUBLE_STAR::/g, ".*");
    return new RegExp(`^${escaped}$`, "i");
}

function normalizePath(value: string): string {
    return value.split(path.sep).join("/");
}

function isCoraPath(filePath: string): boolean {
    return /\.(cora|cs|coratmpl)$/i.test(filePath);
}

function isCoraUri(uri: string): boolean {
    return isCoraPath(URI.parse(uri).fsPath);
}

function getLanguageIdFromPath(filePath: string): string {
    const extension = path.extname(filePath).toLowerCase();
    if (extension === ".cs") {
        return "cora.script";
    }

    if (extension === ".coratmpl") {
        return "cora.template";
    }

    return "cora";
}

function collectDiscoveredModules(): Set<string> {
    const modules = new Set<string>();
    for (const uri of parseCache.keys()) {
        const baseName = path.posix.basename(URI.parse(uri).path);
        const moduleName = baseName.replace(/\.(cora|cs|coratmpl)$/i, "");
        if (moduleName.length > 0) {
            modules.add(moduleName);
        }
    }

    return modules;
}

function buildWorkspaceCompletionItems(): CompletionItem[] {
    const items: CompletionItem[] = [];
    for (const parsed of parseCache.values()) {
        for (const symbol of parsed.symbols) {
            items.push({
                label: symbol.name,
                detail: symbol.detail,
                kind: toCompletionKind(symbol.kind),
            });
        }
    }

    return items;
}

function dedupeCompletionItems(items: CompletionItem[]): CompletionItem[] {
    const seen = new Set<string>();
    const output: CompletionItem[] = [];

    for (const item of items) {
        const key = `${item.label}:${item.kind ?? ""}:${item.detail ?? ""}`;
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        output.push(item);
    }

    return output;
}

function findBestWorkspaceSymbol(name: string): SymbolInfo | null {
    const all: SymbolInfo[] = [];
    for (const parsed of parseCache.values()) {
        all.push(...parsed.symbols);
    }

    return findBestSymbol(all, name);
}

function findSymbolAtPosition(symbols: SymbolInfo[], position: Position): SymbolInfo | null {
    for (const symbol of symbols) {
        if (rangeContains(symbol.range, position)) {
            return symbol;
        }
    }

    return null;
}

function resolveDeclaredTypeTarget(symbol: SymbolInfo): string | null {
    if (symbol.kind === SymbolKind.Variable || symbol.kind === SymbolKind.Parameter) {
        return symbol.declaredTypeName ?? null;
    }

    if (symbol.kind === SymbolKind.Function) {
        return symbol.declaredTypeName ?? null;
    }

    return null;
}

function rangeContains(range: Range, position: Position): boolean {
    if (position.line < range.start.line || position.line > range.end.line) {
        return false;
    }

    if (position.line === range.start.line && position.character < range.start.character) {
        return false;
    }

    if (position.line === range.end.line && position.character > range.end.character) {
        return false;
    }

    return true;
}

function buildParameterNameInlayHints(document: TextDocument, range: Range): InlayHint[] {
    const lines = document.getText().split(/\r?\n/);
    const hints: InlayHint[] = [];
    const callRegex = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/g;

    for (let lineIndex = range.start.line; lineIndex <= Math.min(range.end.line, lines.length - 1); lineIndex += 1) {
        const line = lines[lineIndex] ?? "";

        for (const call of line.matchAll(callRegex)) {
            const functionName = call[1];
            const argsText = call[2] ?? "";
            const signatures = collectSignatures(functionName);
            if (signatures.length === 0 || !argsText.trim()) {
                continue;
            }

            const parameterNames = parseSignatureParameterNames(signatures[0].label);
            const args = splitTopLevelItems(argsText);
            if (parameterNames.length === 0 || args.length === 0) {
                continue;
            }

            const callStart = call.index ?? 0;
            const openParenOffset = line.indexOf("(", callStart);
            if (openParenOffset < 0) {
                continue;
            }

            let searchOffset = openParenOffset + 1;
            for (let argIndex = 0; argIndex < args.length && argIndex < parameterNames.length; argIndex += 1) {
                const arg = args[argIndex];
                const paramName = parameterNames[argIndex];
                const trimmedArg = arg.trim();
                if (!trimmedArg) {
                    continue;
                }

                const argOffset = line.indexOf(trimmedArg, searchOffset);
                if (argOffset < 0) {
                    continue;
                }

                hints.push({
                    position: Position.create(lineIndex, argOffset),
                    label: `${paramName}:`,
                    kind: InlayHintKind.Parameter,
                    paddingRight: true,
                });
                searchOffset = argOffset + trimmedArg.length;
            }
        }
    }

    return hints;
}

function parseSignatureParameterNames(signatureLabel: string): string[] {
    const open = signatureLabel.indexOf("(");
    const close = signatureLabel.lastIndexOf(")");
    if (open < 0 || close <= open) {
        return [];
    }

    const paramsText = signatureLabel.slice(open + 1, close);
    if (!paramsText.trim()) {
        return [];
    }

    return splitTopLevelItems(paramsText)
        .map((item) => item.replace(/\?.*$/, "").replace(/:.*$/, "").trim())
        .filter((item) => item.length > 0);
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
    const builtinTypeNames = new Set(["int", "float", "str", "string", "bool", "void", "job", "none", "any"]);

    const stack: Array<{ token: string; position: Position }> = [];
    const duplicateFnTracker = new Set<string>();
    let currentClass: { name: string; indent: number; braceDepth: number } | null = null;
    let currentFunction: { name: string; indent: number; braceDepth: number; className?: string } | null = null;
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
        if (currentFunction && currentFunction.braceDepth === 0 && leading <= currentFunction.indent && line.trim().length > 0 && !line.trim().startsWith("{")) {
            currentFunction = null;
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

        const funMatch = line.match(/^\s*(?:pub\s+)?fun\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?:->\s*([A-Za-z_][A-Za-z0-9_\.]*(?:\[\])?))?/);
        if (funMatch) {
            const name = funMatch[1];
            const paramsText = funMatch[2].trim();
            const returnType = funMatch[3];
            const params = parseParameterList(paramsText);
            const signatureLabel = formatFunctionSignature(name, params, returnType);
            signatureByName.set(
                name,
                SignatureInformation.create(
                    signatureLabel,
                    undefined,
                    ...params.map((param) => ({ label: formatBinding(param) })),
                ),
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
                typeName: returnType,
                declaredTypeName: returnType,
                signature: signatureLabel,
                containerName: currentClass?.name,
                range,
                selectionRange: range,
                location,
            });
            addDefinition(name, location);

            for (const param of params) {
                const paramOffset = line.indexOf(param.name, funMatch.index ?? 0);
                if (paramOffset < 0) {
                    continue;
                }

                const paramRange = Range.create(
                    Position.create(lineIndex, paramOffset),
                    Position.create(lineIndex, paramOffset + param.name.length),
                );
                const paramLocation = Location.create(document.uri, paramRange);
                symbols.push({
                    name: param.name,
                    kind: SymbolKind.Parameter,
                    detail: formatDeclarationLabel(param.name, param.typeName ?? "any"),
                    typeName: param.typeName,
                    declaredTypeName: param.typeName,
                    containerName: name,
                    range: paramRange,
                    selectionRange: paramRange,
                    location: paramLocation,
                });
                addDefinition(param.name, paramLocation);
            }

            currentFunction = {
                name,
                indent: leading,
                braceDepth,
                className: currentClass?.name,
            };
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

        const declarationMatch = parseDeclaration(line);
        if (declarationMatch) {
            const nameOffset = line.indexOf(declarationMatch.name);
            const start = Position.create(lineIndex, nameOffset);
            const end = Position.create(lineIndex, nameOffset + declarationMatch.name.length);
            const range = Range.create(start, end);
            const location = Location.create(document.uri, range);
            const knownTypes = new Set<string>([
                ...builtinTypeNames,
                ...symbols.filter((entry) => entry.kind === SymbolKind.Class).map((entry) => entry.name),
                currentClass?.name ?? "",
                currentFunction?.name ?? "",
            ].filter((entry) => entry.length > 0));
            const inferredType = declarationMatch.typeName ?? inferExpressionType(declarationMatch.initializer ?? "", knownTypes);
            const bindingKind = line.includes("const") ? "const" : "let";
            symbols.push({
                name: declarationMatch.name,
                kind: SymbolKind.Variable,
                detail: formatDeclarationLabel(declarationMatch.name, inferredType ?? "any"),
                typeName: inferredType,
                declaredTypeName: declarationMatch.typeName,
                declaration: `${bindingKind} ${declarationMatch.name}${inferredType ? `: ${inferredType}` : ""}`,
                containerName: currentFunction?.name ?? currentClass?.name,
                range,
                selectionRange: range,
                location,
            });
            addDefinition(declarationMatch.name, location);
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
        if (currentFunction && braceDepth < currentFunction.braceDepth) {
            currentFunction = null;
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

    const discoveredModules = collectDiscoveredModules();

    for (const imported of importedModules) {
        if (!isImportUsedInLines(lines, imported.module, imported.range.start.line)) {
            diagnostics.push({
                severity: DiagnosticSeverity.Warning,
                range: imported.range,
                message: `Unused import '${imported.module}'.`,
                source: "cora-lsp",
            });
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

    const ignoredWords = new Set<string>([
        "class", "fun", "import", "let", "const", "pub", "if", "else", "while", "for", "return",
        "break", "continue", "and", "or", "not", "this", "true", "false", "none",
        ...builtinModules,
        ...Array.from(builtinTopLevelFunctions.keys()),
        ...Array.from(keywordDocs.keys()),
        ...Array.from(builtinTypeNames),
    ]);

    for (const [name, refs] of references.entries()) {
        if (ignoredWords.has(name) || definitions.has(name)) {
            continue;
        }

        const hasWorkspaceDefinition = collectDefinitionLocations(name).length > 0;
        if (hasWorkspaceDefinition) {
            continue;
        }

        const candidate = refs.find((location) => !importedModules.some((entry) => entry.range.start.line === location.range.start.line));
        if (!candidate) {
            continue;
        }

        diagnostics.push({
            severity: DiagnosticSeverity.Warning,
            range: candidate.range,
            message: `Unknown symbol '${name}'.`,
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

function collectUnusedImports(
    document: TextDocument,
    imports: Array<{ module: string; range: Range }>,
): Array<{ module: string; range: Range }> {
    const lines = stripBlockCommentSegments(document.getText()).split(/\r?\n/);
    return imports.filter((entry) => !isImportUsedInLines(lines, entry.module, entry.range.start.line));
}

function isImportUsedInLines(lines: string[], moduleName: string, importLine: number): boolean {
    const pattern = new RegExp(`\\b${escapeRegExp(moduleName)}(?:\\b|\\s*\\.)`);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        if (lineIndex === importLine) {
            continue;
        }

        const line = stripStringAndCommentSegments(lines[lineIndex] ?? "");
        if (pattern.test(line)) {
            return true;
        }
    }

    return false;
}

function buildExtractVariableAction(document: TextDocument, range: Range, selectedText: string): CodeAction | null {
    if (range.start.line !== range.end.line) {
        return null;
    }

    const cleanSelection = selectedText.trim();
    if (!cleanSelection || !isSafeExtractVariableSelection(document, range, cleanSelection)) {
        return null;
    }

    const variableName = createUniqueSymbolName("extractedValue", ensureParsed(document));
    const currentLine = getDocumentLine(document, range.start.line);
    const indent = currentLine.match(/^\s*/)?.[0] ?? "";
    const declarationLine = `${indent}let ${variableName} = ${cleanSelection};\n`;

    return {
        title: "Extract to variable",
        kind: CodeActionKind.RefactorExtract,
        edit: {
            changes: {
                [document.uri]: [
                    {
                        range: Range.create(Position.create(range.start.line, 0), Position.create(range.start.line, 0)),
                        newText: declarationLine,
                    },
                    {
                        range,
                        newText: variableName,
                    },
                ],
            },
        },
    };
}

function buildExtractMethodAction(document: TextDocument, range: Range, selectedText: string): CodeAction | null {
    const cleanSelection = selectedText.trim();
    if (!cleanSelection) {
        return null;
    }

    const extractContext = getMethodExtractionContext(document, range, cleanSelection);
    if (!extractContext) {
        return null;
    }

    const methodName = createUniqueSymbolName("extractedMethod", ensureParsed(document));
    const lineCount = document.lineCount;
    const endPosition = Position.create(lineCount, 0);
    const callIndent = extractContext.indent;

    const normalizedBody = extractContext.selectedLines
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .map((line) => `\t${line}`)
        .join("\n");
    const methodText = `\nfun ${methodName}() {\n${normalizedBody}\n}\n`;

    return {
        title: "Extract to method",
        kind: CodeActionKind.RefactorExtract,
        edit: {
            changes: {
                [document.uri]: [
                    {
                        range,
                        newText: `${callIndent}${methodName}()`,
                    },
                    {
                        range: Range.create(endPosition, endPosition),
                        newText: methodText,
                    },
                ],
            },
        },
    };
}

function buildAutoImportActions(document: TextDocument, params: CodeActionParams): CodeAction[] {
    const diagnostics = params.context.diagnostics.filter((diag) => diag.message.startsWith("Unknown symbol '"));
    if (diagnostics.length === 0 && params.context.triggerKind !== CodeActionTriggerKind.Invoked) {
        return [];
    }

    const imports = collectImports(document);
    const existingModules = new Set(imports.map((item) => item.module));
    const names = new Set<string>();

    for (const diag of diagnostics) {
        const match = diag.message.match(/^Unknown symbol '([A-Za-z_][A-Za-z0-9_]*)'\./);
        if (match) {
            names.add(match[1]);
        }
    }

    if (names.size === 0) {
        const word = getWordAtPosition(document, params.range.start);
        if (word) {
            names.add(word.text);
        }
    }

    const actions: CodeAction[] = [];
    for (const name of names) {
        const moduleCandidates = rankImportCandidatesForSymbol(name, document.uri)
            .filter((moduleName) => !existingModules.has(moduleName))
            .slice(0, 5);

        for (const moduleName of moduleCandidates) {
            const insertPosition = findImportInsertionPosition(document);
            actions.push({
                title: `Import '${moduleName}' for '${name}'`,
                kind: CodeActionKind.QuickFix,
                diagnostics,
                edit: {
                    changes: {
                        [document.uri]: [
                            {
                                range: Range.create(insertPosition, insertPosition),
                                newText: `import ${moduleName}\n`,
                            },
                        ],
                    },
                },
            });
        }
    }

    return actions;
}

function rankImportCandidatesForSymbol(name: string, currentUri: string): string[] {
    const ranked = new Map<string, number>();
    const currentDir = path.dirname(URI.parse(currentUri).fsPath);

    for (const [uri, parsed] of parseCache.entries()) {
        if (uri === currentUri) {
            continue;
        }

        if (!parsed.symbols.some((symbol) => symbol.name === name)) {
            continue;
        }

        const baseName = path.posix.basename(URI.parse(uri).path);
        const moduleName = baseName.replace(/\.(cora|cs|coratmpl)$/i, "");
        if (moduleName) {
            const targetDir = path.dirname(URI.parse(uri).fsPath);
            const folderDistance = calculateFolderDistance(currentDir, targetDir);
            const sameFolderBonus = normalizePath(currentDir) === normalizePath(targetDir) ? 1000 : 0;
            const pathLengthPenalty = Math.max(0, normalizePath(URI.parse(uri).fsPath).length - normalizePath(currentDir).length);
            const score = sameFolderBonus - folderDistance * 10 - pathLengthPenalty;
            const existing = ranked.get(moduleName);
            if (existing === undefined || score > existing) {
                ranked.set(moduleName, score);
            }
        }
    }

    return Array.from(ranked.entries())
        .sort((left, right) => {
            if (left[1] !== right[1]) {
                return right[1] - left[1];
            }

            if (left[0].length !== right[0].length) {
                return left[0].length - right[0].length;
            }

            return left[0].localeCompare(right[0]);
        })
        .map(([moduleName]) => moduleName);
}

function calculateFolderDistance(fromDir: string, toDir: string): number {
    const fromParts = normalizePath(fromDir).split("/").filter((part) => part.length > 0);
    const toParts = normalizePath(toDir).split("/").filter((part) => part.length > 0);
    let shared = 0;

    while (shared < fromParts.length && shared < toParts.length && fromParts[shared].toLowerCase() === toParts[shared].toLowerCase()) {
        shared += 1;
    }

    return (fromParts.length - shared) + (toParts.length - shared);
}

function isSafeExtractVariableSelection(document: TextDocument, range: Range, selectedText: string): boolean {
    const lineText = getDocumentLine(document, range.start.line);
    const linePrefix = lineText.slice(0, range.start.character);
    const lineSuffix = lineText.slice(range.end.character);
    const statementLikePattern = /^\s*(?:class|fun|import|let|const|pub)\b/;

    if (statementLikePattern.test(selectedText)) {
        return false;
    }

    if (selectedText.includes("\n") || selectedText.endsWith(";") || /[{}]/.test(selectedText)) {
        return false;
    }

    if (linePrefix.trim().length === 0 && lineSuffix.trim().length === 0) {
        return false;
    }

    return hasBalancedInlineDelimiters(selectedText);
}

function getMethodExtractionContext(document: TextDocument, range: Range, selectedText: string): { indent: string; selectedLines: string } | null {
    const firstLine = getDocumentLine(document, range.start.line);
    const lastLine = getDocumentLine(document, range.end.line);
    const firstIndent = firstLine.match(/^\s*/)?.[0] ?? "";

    if (firstIndent.length > 0) {
        return null;
    }

    const expectedStart = firstIndent.length;
    const expectedEnd = lastLine.trimEnd().length;
    if (range.start.character !== expectedStart || range.end.character !== expectedEnd) {
        return null;
    }

    if (/\breturn\b/.test(selectedText)) {
        return null;
    }

    const selectedLines = selectedText.split(/\r?\n/);
    if (selectedLines.some((line) => line.trim().length === 0)) {
        return null;
    }

    if (!hasBalancedInlineDelimiters(selectedText)) {
        return null;
    }

    return {
        indent: firstIndent,
        selectedLines: selectedLines.join("\n"),
    };
}

function getDocumentLine(document: TextDocument, line: number): string {
    const start = Position.create(line, 0);
    const nextLine = Math.min(document.lineCount, line + 1);
    const end = nextLine >= document.lineCount
        ? document.positionAt(document.getText().length)
        : Position.create(nextLine, 0);
    const value = document.getText(Range.create(start, end));
    return value.replace(/\r?\n$/, "");
}

function hasBalancedInlineDelimiters(text: string): boolean {
    let paren = 0;
    let bracket = 0;

    for (const char of text) {
        if (char === "(") {
            paren += 1;
        } else if (char === ")") {
            paren -= 1;
        } else if (char === "[") {
            bracket += 1;
        } else if (char === "]") {
            bracket -= 1;
        }

        if (paren < 0 || bracket < 0) {
            return false;
        }
    }

    return paren === 0 && bracket === 0;
}

function findImportInsertionPosition(document: TextDocument): Position {
    const imports = collectImports(document);
    if (imports.length === 0) {
        return Position.create(0, 0);
    }

    const last = imports[imports.length - 1];
    return Position.create(last.range.end.line + 1, 0);
}

function createUniqueSymbolName(seed: string, parsed: ParsedDocument): string {
    const existing = new Set(parsed.symbols.map((symbol) => symbol.name));
    if (!existing.has(seed)) {
        return seed;
    }

    let suffix = 1;
    while (existing.has(`${seed}${suffix}`)) {
        suffix += 1;
    }

    return `${seed}${suffix}`;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSemanticTokens(document: TextDocument): SemanticTokens {
    const builder = new SemanticTokensBuilder();
    const sourceText = document.getText();
    const lines = sourceText.split(/\r?\n/);
    const strippedLines = stripBlockCommentSegments(sourceText).split(/\r?\n/);
    const parsed = ensureParsed(document);
    const keywordRegex = /\b(class|fun|import|let|const|pub|if|else|while|for|return|break|continue|and|or|not|this)\b/g;
    const typeRegex = /\b(int|float|str|string|bool|void|job)\b/g;
    const numberRegex = /\b\d+(?:\.\d+)?\b/g;
    const operatorRegex = /\+|-|\*|\/|%|==|!=|<=|>=|<|>|=|->|:/g;
    const pushed = new Set<string>();
    const pushToken = (line: number, start: number, length: number, tokenType: string, tokenModifier?: string) => {
        const tokenTypeIndex = semanticTokenLegend.tokenTypes.indexOf(tokenType);
        if (tokenTypeIndex < 0) {
            return;
        }

        const tokenModifierIndex = tokenModifier
            ? semanticTokenLegend.tokenModifiers.indexOf(tokenModifier)
            : 0;
        const modifierValue = tokenModifierIndex >= 0 ? tokenModifierIndex : 0;
        const key = `${line}:${start}:${length}:${tokenTypeIndex}:${modifierValue}`;
        if (pushed.has(key)) {
            return;
        }

        pushed.add(key);
        builder.push(line, start, length, tokenTypeIndex, modifierValue);
    };

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        const strippedLine = strippedLines[lineIndex] ?? line;

        for (const match of strippedLine.matchAll(/\/\/.*$|#.*$/g)) {
            if (match.index !== undefined) {
                pushToken(lineIndex, match.index, match[0].length, SemanticTokenTypes.comment);
            }
        }

        for (const match of line.matchAll(/\/\*[^]*?\*\//g)) {
            if (match.index !== undefined) {
                pushToken(lineIndex, match.index, match[0].length, SemanticTokenTypes.comment);
            }
        }

        for (const match of line.matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g)) {
            if (match.index !== undefined) {
                pushToken(lineIndex, match.index, match[0].length, SemanticTokenTypes.string);
            }
        }

        for (const match of line.matchAll(numberRegex)) {
            if (match.index !== undefined) {
                pushToken(lineIndex, match.index, match[0].length, SemanticTokenTypes.number);
            }
        }

        for (const match of line.matchAll(keywordRegex)) {
            if (match.index !== undefined) {
                pushToken(lineIndex, match.index, match[0].length, SemanticTokenTypes.keyword);
            }
        }

        for (const match of line.matchAll(typeRegex)) {
            if (match.index !== undefined) {
                pushToken(lineIndex, match.index, match[0].length, SemanticTokenTypes.type);
            }
        }

        for (const match of line.matchAll(operatorRegex)) {
            if (match.index !== undefined) {
                pushToken(lineIndex, match.index, match[0].length, SemanticTokenTypes.operator);
            }
        }

        const classMatch = line.match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (classMatch) {
            const name = classMatch[1];
            const index = line.indexOf(name);
            pushToken(lineIndex, index, name.length, SemanticTokenTypes.class, SemanticTokenModifiers.declaration);
        }

        const funMatch = line.match(/^\s*(?:pub\s+)?fun\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (funMatch) {
            const name = funMatch[1];
            const index = line.indexOf(name);
            pushToken(lineIndex, index, name.length, SemanticTokenTypes.function, SemanticTokenModifiers.declaration);
        }

        const importMatch = line.match(/^\s*import\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (importMatch) {
            const name = importMatch[1];
            const index = line.indexOf(name);
            pushToken(lineIndex, index, name.length, SemanticTokenTypes.namespace);
        }

        for (const match of line.matchAll(/\b(?:pub\s+)?(?:let|const)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
            const name = match[1];
            const idx = line.indexOf(name, match.index ?? 0);
            pushToken(lineIndex, idx, name.length, SemanticTokenTypes.variable, SemanticTokenModifiers.declaration);
        }
    }

    for (const symbol of parsed.symbols) {
        const tokenType = (() => {
            switch (symbol.kind) {
                case SymbolKind.Class:
                    return SemanticTokenTypes.class;
                case SymbolKind.Function:
                    return SemanticTokenTypes.function;
                case SymbolKind.Parameter:
                    return SemanticTokenTypes.parameter;
                case SymbolKind.Variable:
                    return SemanticTokenTypes.variable;
                case SymbolKind.Module:
                    return SemanticTokenTypes.namespace;
                default:
                    return null;
            }
        })();

        if (!tokenType) {
            continue;
        }

        const line = symbol.range.start.line;
        const start = symbol.range.start.character;
        const length = Math.max(1, symbol.range.end.character - symbol.range.start.character);
        pushToken(line, start, length, tokenType, SemanticTokenModifiers.declaration);
    }

    return builder.build();
}

function findBestSymbol(symbols: SymbolInfo[], name: string): SymbolInfo | null {
    const matches = symbols.filter((symbol) => symbol.name === name);
    if (matches.length === 0) {
        return null;
    }

    const kindRank = new Map<SymbolKind, number>([
        [SymbolKind.Parameter, 0],
        [SymbolKind.Variable, 1],
        [SymbolKind.Function, 2],
        [SymbolKind.Class, 3],
        [SymbolKind.Module, 4],
    ]);

    return [...matches].sort((left, right) => (kindRank.get(left.kind) ?? 99) - (kindRank.get(right.kind) ?? 99))[0] ?? null;
}

function formatSymbolHoverMarkdown(symbol: SymbolInfo): string {
    const lines: string[] = [`**${symbol.name}**`];

    switch (symbol.kind) {
        case SymbolKind.Class:
            lines.push(codeBlock("cora", `class ${symbol.name}`));
            break;
        case SymbolKind.Function:
            lines.push(codeBlock("cora", symbol.signature ?? symbol.detail ?? symbol.name));
            if (symbol.typeName) {
                lines.push(`Returns ${symbol.typeName}`);
            }
            break;
        case SymbolKind.Parameter:
            lines.push(codeBlock("cora", symbol.declaration ?? `${symbol.name}${symbol.typeName ? `: ${symbol.typeName}` : ""}`));
            lines.push(`Parameter type: ${symbol.typeName ?? "any"}`);
            break;
        case SymbolKind.Variable:
            lines.push(codeBlock("cora", symbol.declaration ?? `${symbol.name}${symbol.typeName ? `: ${symbol.typeName}` : ""}`));
            lines.push(`Declaration type: ${symbol.typeName ?? "any"}`);
            break;
        case SymbolKind.Module:
            lines.push(codeBlock("cora", `import ${symbol.name}`));
            break;
        default:
            if (symbol.detail) {
                lines.push(symbol.detail);
            }
            break;
    }

    if (symbol.detail && symbol.kind !== SymbolKind.Function && symbol.kind !== SymbolKind.Parameter && symbol.kind !== SymbolKind.Variable) {
        lines.push(symbol.detail);
    }

    return joinMarkdownSections(...lines);
}

documents.listen(connection);
connection.listen();
