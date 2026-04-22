import { inlineCode } from "./markdown";

export type ParsedBinding = {
    name: string;
    typeName?: string;
    optional?: boolean;
    raw: string;
};

export function splitTopLevelItems(text: string): string[] {
    const items: string[] = [];
    let depth = 0;
    let current = "";

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (char === "," && depth === 0) {
            if (current.trim().length > 0) {
                items.push(current.trim());
            }
            current = "";
            continue;
        }

        if (char === "(" || char === "[" || char === "{") {
            depth += 1;
        } else if (char === ")" || char === "]" || char === "}") {
            depth = Math.max(0, depth - 1);
        }

        current += char;
    }

    if (current.trim().length > 0) {
        items.push(current.trim());
    }

    return items;
}

export function parseTypedBinding(text: string): ParsedBinding | null {
    const trimmed = text.trim();
    if (!trimmed) {
        return null;
    }

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)(\?)?(?:\s*:\s*([A-Za-z_][A-Za-z0-9_\.]*(?:\[\])?))?/);
    if (!match) {
        return null;
    }

    return {
        name: match[1],
        optional: Boolean(match[2]),
        typeName: match[3],
        raw: trimmed,
    };
}

export function parseParameterList(text: string): ParsedBinding[] {
    if (!text.trim()) {
        return [];
    }

    return splitTopLevelItems(text).map(parseTypedBinding).filter((item): item is ParsedBinding => Boolean(item));
}

export function parseDeclaration(text: string): { name: string; typeName?: string; initializer?: string } | null {
    const match = text.trim().match(/^(?:pub\s+)?(?:let|const)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*:\s*([A-Za-z_][A-Za-z0-9_\.]*(?:\[\])?))?(?:\s*=\s*([^;]+))?/);
    if (!match) {
        return null;
    }

    return {
        name: match[1],
        typeName: match[2],
        initializer: match[3]?.trim(),
    };
}

export function inferExpressionType(expression: string, knownTypes: Set<string> = new Set()): string | undefined {
    const trimmed = expression.trim();
    if (!trimmed) {
        return undefined;
    }

    if (/^(?:none|null)$/i.test(trimmed)) {
        return "none";
    }

    if (/^(?:true|false)$/i.test(trimmed)) {
        return "bool";
    }

    if (/^"(?:\\.|[^"\\])*"$/.test(trimmed) || /^'(?:\\.|[^'\\])*'$/.test(trimmed)) {
        return "str";
    }

    if (/^\d+\.\d+(?:[eE][+-]?\d+)?$/.test(trimmed)) {
        return "float";
    }

    if (/^\d+$/.test(trimmed)) {
        return "int";
    }

    const constructorMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (constructorMatch && knownTypes.has(constructorMatch[1])) {
        return constructorMatch[1];
    }

    const castMatch = trimmed.match(/^(string|str|int|float|bool)\s*\(/);
    if (castMatch) {
        return castMatch[1] === "string" ? "str" : castMatch[1];
    }

    return undefined;
}

export function formatBinding(binding: ParsedBinding): string {
    const optionalSuffix = binding.optional ? "?" : "";
    if (!binding.typeName) {
        return binding.name + optionalSuffix;
    }

    return `${binding.name}${optionalSuffix}: ${binding.typeName}`;
}

export function formatDeclarationLabel(name: string, typeName?: string): string {
    return typeName ? `${name}: ${typeName}` : name;
}

export function formatVariableSnippet(kind: "let" | "const", name: string, typeName?: string, initializer?: string): string {
    const typePart = typeName ? `: ${typeName}` : "";
    const initPart = initializer ? ` = ${initializer}` : "";
    return `${kind} ${name}${typePart}${initPart}`;
}

export function formatFunctionSignature(name: string, params: ParsedBinding[], returnType?: string): string {
    const signature = `${name}(${params.map(formatBinding).join(", ")})`;
    return returnType ? `${signature} -> ${returnType}` : signature;
}

export function formatSymbolKindLabel(kind: string): string {
    return inlineCode(kind);
}
