import {
    CompletionItem,
    CompletionItemKind,
    InsertTextFormat,
    Position,
    Range,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";

export type BuiltinMemberDoc = {
    name: string;
    signature: string;
    documentation: string;
    kind: CompletionItemKind;
};

export type BuiltinClassDoc = {
    name: string;
    documentation: string;
    methods: BuiltinMemberDoc[];
};

export type BuiltinModuleDoc = {
    name: string;
    documentation: string;
    functions: BuiltinMemberDoc[];
    classes: BuiltinClassDoc[];
};

export const builtinModuleDocs = new Map<string, BuiltinModuleDoc>([
    [
        "io",
        {
            name: "io",
            documentation: "Input/output helpers for console and file operations.",
            functions: [
                {
                    name: "read",
                    signature: "read(path: str) -> str",
                    documentation: "Reads the full file contents and returns a string.",
                    kind: CompletionItemKind.Function,
                },
                {
                    name: "write",
                    signature: "write(path: str, content: str) -> void",
                    documentation: "Writes text content to a file path.",
                    kind: CompletionItemKind.Function,
                },
                {
                    name: "exists",
                    signature: "exists(path: str) -> bool",
                    documentation: "Returns true when the path exists.",
                    kind: CompletionItemKind.Function,
                },
            ],
            classes: [],
        },
    ],
    [
        "math",
        {
            name: "math",
            documentation: "Math primitives and utility functions.",
            functions: [
                {
                    name: "sqrt",
                    signature: "sqrt(value: float) -> float",
                    documentation: "Computes the square root of a number.",
                    kind: CompletionItemKind.Function,
                },
                {
                    name: "pow",
                    signature: "pow(base: float, exponent: float) -> float",
                    documentation: "Raises base to exponent.",
                    kind: CompletionItemKind.Function,
                },
                {
                    name: "abs",
                    signature: "abs(value: float) -> float",
                    documentation: "Returns absolute value.",
                    kind: CompletionItemKind.Function,
                },
            ],
            classes: [],
        },
    ],
    [
        "vector",
        {
            name: "vector",
            documentation: "Vector and collection data structures.",
            functions: [],
            classes: [
                {
                    name: "Vector",
                    documentation: "Resizable collection supporting index-based operations.",
                    methods: [
                        {
                            name: "push",
                            signature: "push(value: any) -> void",
                            documentation: "Appends an item to the end of the vector.",
                            kind: CompletionItemKind.Method,
                        },
                        {
                            name: "pop",
                            signature: "pop() -> any",
                            documentation: "Removes and returns the last item.",
                            kind: CompletionItemKind.Method,
                        },
                        {
                            name: "len",
                            signature: "len() -> int",
                            documentation: "Returns the number of items in the vector.",
                            kind: CompletionItemKind.Method,
                        },
                    ],
                },
            ],
        },
    ],
    [
        "exception",
        {
            name: "exception",
            documentation: "Error types and exception helpers.",
            functions: [
                {
                    name: "raise",
                    signature: "raise(error: Error) -> void",
                    documentation: "Raises an exception value.",
                    kind: CompletionItemKind.Function,
                },
            ],
            classes: [
                {
                    name: "Error",
                    documentation: "Base exception object.",
                    methods: [
                        {
                            name: "message",
                            signature: "message() -> str",
                            documentation: "Returns the exception message.",
                            kind: CompletionItemKind.Method,
                        },
                    ],
                },
            ],
        },
    ],
]);

export const builtinModules = new Set(Array.from(builtinModuleDocs.keys()));

export const keywordDocs = new Map<string, string>([
    ["class", "Declares a class type."],
    ["fun", "Declares a function."],
    ["import", "Imports a module namespace."],
    ["let", "Declares a mutable variable."],
    ["const", "Declares an immutable binding."],
    ["pub", "Declares a public symbol."],
    ["if", "Starts a conditional branch."],
    ["else", "Fallback branch for conditionals."],
    ["while", "Repeats while a condition is true."],
    ["for", "Iterates over a range or c-style loop."],
    ["return", "Returns from a function."],
    ["break", "Breaks out of loop."],
    ["continue", "Skips to next loop iteration."],
    ["none", "Represents an empty value."],
    ["true", "Boolean true literal."],
    ["false", "Boolean false literal."],
    ["this", "Current object instance."],
]);

export const builtinTopLevelFunctions = new Map<string, BuiltinMemberDoc>([
    [
        "print",
        {
            name: "print",
            signature: "print(value: any) -> void",
            documentation: "Writes a value to the active output stream.",
            kind: CompletionItemKind.Function,
        },
    ],
    [
        "range",
        {
            name: "range",
            signature: "range(start: int, end?: int, step?: int) -> job",
            documentation: "Creates an iterable numeric sequence.",
            kind: CompletionItemKind.Function,
        },
    ],
    [
        "str",
        {
            name: "str",
            signature: "str(value: any) -> str",
            documentation: "Converts a value to string.",
            kind: CompletionItemKind.Function,
        },
    ],
    [
        "int",
        {
            name: "int",
            signature: "int(value: any) -> int",
            documentation: "Converts a value to integer.",
            kind: CompletionItemKind.Function,
        },
    ],
    [
        "float",
        {
            name: "float",
            signature: "float(value: any) -> float",
            documentation: "Converts a value to floating-point number.",
            kind: CompletionItemKind.Function,
        },
    ],
    [
        "bool",
        {
            name: "bool",
            signature: "bool(value: any) -> bool",
            documentation: "Converts a value to boolean.",
            kind: CompletionItemKind.Function,
        },
    ],
]);

export function createBuiltinBaseItems(): CompletionItem[] {
    const keywordItems: CompletionItem[] = [
        "class",
        "fun",
        "import",
        "let",
        "const",
        "pub",
        "if",
        "else",
        "while",
        "for",
        "return",
        "break",
        "continue",
        "and",
        "or",
        "not",
    ].map((label) => ({ label, kind: CompletionItemKind.Keyword }));

    const typeItems: CompletionItem[] = ["int", "float", "str", "string", "bool", "void", "job"].map((label) => ({
        label,
        kind: CompletionItemKind.TypeParameter,
    }));

    const functionItems: CompletionItem[] = ["range", "print", "string", "str", "float", "int", "bool"].map((label) => {
        const doc = builtinTopLevelFunctions.get(label);
        return {
            label,
            kind: CompletionItemKind.Function,
            detail: doc?.signature,
            documentation: doc
                ? {
                    kind: "markdown" as const,
                    value: `**${doc.name}**\\n\\n\`${doc.signature}\`\\n\\n${doc.documentation}`,
                }
                : undefined,
        };
    });

    const moduleItems: CompletionItem[] = Array.from(builtinModuleDocs.values()).map((moduleDoc) => ({
        label: moduleDoc.name,
        kind: CompletionItemKind.Module,
        detail: "builtin module",
        documentation: {
            kind: "markdown" as const,
            value: `**${moduleDoc.name}**\\n\\n${moduleDoc.documentation}`,
        },
    }));

    const snippetItems: CompletionItem[] = [
        {
            label: "class",
            kind: CompletionItemKind.Snippet,
            detail: "class snippet",
            insertTextFormat: InsertTextFormat.Snippet,
            insertText: "class ${1:Name} {\n\t$0\n}",
        },
        {
            label: "fun",
            kind: CompletionItemKind.Snippet,
            detail: "function snippet",
            insertTextFormat: InsertTextFormat.Snippet,
            insertText: "fun ${1:name}(${2:args}) -> ${3:void} {\n\t$0\n}",
        },
        {
            label: "__add__",
            kind: CompletionItemKind.Method,
            detail: "operator overload",
            insertTextFormat: InsertTextFormat.Snippet,
            insertText: "__add__(${1:other})",
        },
        {
            label: "__sub__",
            kind: CompletionItemKind.Method,
            detail: "operator overload",
            insertTextFormat: InsertTextFormat.Snippet,
            insertText: "__sub__(${1:other})",
        },
        {
            label: "__mul__",
            kind: CompletionItemKind.Method,
            detail: "operator overload",
            insertTextFormat: InsertTextFormat.Snippet,
            insertText: "__mul__(${1:value})",
        },
        {
            label: "__eq__",
            kind: CompletionItemKind.Method,
            detail: "operator overload",
            insertTextFormat: InsertTextFormat.Snippet,
            insertText: "__eq__(${1:other})",
        },
    ];

    return [...keywordItems, ...typeItems, ...functionItems, ...moduleItems, ...snippetItems];
}

export function getBuiltinTopLevelFunctionDoc(name: string): BuiltinMemberDoc | undefined {
    return builtinTopLevelFunctions.get(name);
}

export function getBuiltinMemberDoc(moduleName: string, memberName: string): BuiltinMemberDoc | undefined {
    const moduleDoc = builtinModuleDocs.get(moduleName);
    if (!moduleDoc) {
        return undefined;
    }

    const functionMember = moduleDoc.functions.find((entry) => entry.name === memberName);
    if (functionMember) {
        return functionMember;
    }

    for (const classDoc of moduleDoc.classes) {
        if (classDoc.name === memberName) {
            return {
                name: classDoc.name,
                signature: `${classDoc.name}()`,
                documentation: classDoc.documentation,
                kind: CompletionItemKind.Class,
            };
        }

        const methodDoc = classDoc.methods.find((method) => method.name === memberName);
        if (methodDoc) {
            return methodDoc;
        }
    }

    return undefined;
}

export function getBuiltinMemberCompletionItems(moduleName: string): CompletionItem[] {
    const moduleDoc = builtinModuleDocs.get(moduleName);
    if (!moduleDoc) {
        return [];
    }

    const functionItems = moduleDoc.functions.map((item) => ({
        label: item.name,
        kind: item.kind,
        detail: item.signature,
        documentation: {
            kind: "markdown" as const,
            value: `**${moduleName}.${item.name}**\\n\\n\`${item.signature}\`\\n\\n${item.documentation}`,
        },
    }));

    const classItems = moduleDoc.classes.flatMap((classDoc) => {
        const classItem: CompletionItem = {
            label: classDoc.name,
            kind: CompletionItemKind.Class,
            detail: `${classDoc.name}()`,
            documentation: {
                kind: "markdown" as const,
                value: `**${moduleName}.${classDoc.name}**\\n\\n${classDoc.documentation}`,
            },
        };

        const methodItems = classDoc.methods.map((method) => ({
            label: method.name,
            kind: method.kind,
            detail: method.signature,
            documentation: {
                kind: "markdown" as const,
                value: `**${moduleName}.${classDoc.name}.${method.name}**\\n\\n\`${method.signature}\`\\n\\n${method.documentation}`,
            },
        }));

        return [classItem, ...methodItems];
    });

    return [...functionItems, ...classItems];
}

export function formatBuiltinModuleMarkdown(moduleDoc: BuiltinModuleDoc): string {
    const sections: string[] = [`**${moduleDoc.name}**`, "", moduleDoc.documentation];

    if (moduleDoc.functions.length > 0) {
        sections.push("", "Functions:");
        for (const fn of moduleDoc.functions) {
            sections.push(`- \`${fn.signature}\` — ${fn.documentation}`);
        }
    }

    if (moduleDoc.classes.length > 0) {
        sections.push("", "Classes:");
        for (const classDoc of moduleDoc.classes) {
            sections.push(`- **${classDoc.name}** — ${classDoc.documentation}`);
            for (const method of classDoc.methods) {
                sections.push(`  - \`${method.signature}\` — ${method.documentation}`);
            }
        }
    }

    return sections.join("\n");
}

export function getMemberAccessContext(document: TextDocument, position: Position): { moduleName: string } | null {
    const lineRange = Range.create(Position.create(position.line, 0), position);
    const prefix = document.getText(lineRange);
    const match = prefix.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*[A-Za-z_0-9]*$/);
    if (!match) {
        return null;
    }

    const moduleName = match[1];
    if (!builtinModules.has(moduleName)) {
        return null;
    }

    return { moduleName };
}
