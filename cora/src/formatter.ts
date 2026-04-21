export type CoraFormatterOptions = {
    indentToken: string;
    sortImports?: boolean;
    collapseMultipleBlankLines?: boolean;
    ensureFinalNewline?: boolean;
};

const DEFAULT_OPTIONS: Omit<CoraFormatterOptions, "indentToken"> = {
    sortImports: true,
    collapseMultipleBlankLines: true,
    ensureFinalNewline: true,
};

export function formatCoraDocument(text: string, options: CoraFormatterOptions): string {
    const merged = { ...DEFAULT_OPTIONS, ...options };
    const normalized = text.replace(/\r\n?/g, "\n");
    let lines = normalized.split("\n");

    if (merged.sortImports) {
        lines = sortLeadingImports(lines);
    }

    const out: string[] = [];
    let indentLevel = 0;
    let previousBlank = false;

    for (const rawLine of lines) {
        const trimmedRight = rawLine.replace(/[ \t]+$/g, "");
        const trimmed = trimmedRight.trim();

        if (trimmed.length === 0) {
            const allowBlank = !merged.collapseMultipleBlankLines || !previousBlank;
            if (allowBlank) {
                out.push("");
                previousBlank = true;
            }
            continue;
        }

        if (isDedentLine(trimmed)) {
            indentLevel = Math.max(0, indentLevel - 1);
        }

        out.push(`${options.indentToken.repeat(indentLevel)}${trimmed}`);
        previousBlank = false;

        if (isIndentLine(trimmed)) {
            indentLevel += 1;
        }
    }

    const compact = out.join("\n").replace(/\n{3,}/g, "\n\n");
    if (merged.ensureFinalNewline) {
        return compact.endsWith("\n") ? compact : `${compact}\n`;
    }

    return compact;
}

export function formatCoraRange(
    text: string,
    startLine: number,
    endLine: number,
    options: CoraFormatterOptions,
): string {
    const normalized = text.replace(/\r\n?/g, "\n");
    const lines = normalized.split("\n");

    const from = Math.max(0, startLine);
    const to = Math.min(lines.length - 1, endLine);
    if (from > to) {
        return "";
    }

    const chunk = lines.slice(from, to + 1).join("\n");
    return formatCoraDocument(chunk, { ...options, ensureFinalNewline: false });
}

function sortLeadingImports(lines: string[]): string[] {
    let firstImport = -1;
    let lastImport = -1;

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const trimmed = line.trim();

        if (trimmed.length === 0 || trimmed.startsWith("//") || trimmed.startsWith("#")) {
            if (firstImport !== -1) {
                break;
            }
            continue;
        }

        if (/^import\s+[A-Za-z_][A-Za-z0-9_]*\s*$/.test(trimmed)) {
            if (firstImport === -1) {
                firstImport = index;
            }
            lastImport = index;
            continue;
        }

        if (firstImport !== -1) {
            break;
        }
    }

    if (firstImport === -1 || lastImport === -1) {
        return lines;
    }

    const imports = lines
        .slice(firstImport, lastImport + 1)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .sort((left, right) => left.localeCompare(right));

    const deduplicated: string[] = [];
    for (const statement of imports) {
        if (deduplicated[deduplicated.length - 1] !== statement) {
            deduplicated.push(statement);
        }
    }

    const next = [...lines];
    next.splice(firstImport, lastImport - firstImport + 1, ...deduplicated);
    return next;
}

function isDedentLine(trimmedLine: string): boolean {
    return (
        trimmedLine.startsWith("}")
        || trimmedLine === "else:"
        || trimmedLine.startsWith("else ")
        || trimmedLine.startsWith("catch")
        || trimmedLine.startsWith("finally")
    );
}

function isIndentLine(trimmedLine: string): boolean {
    return (
        trimmedLine.endsWith("{")
        || /\b(if|for|while|class|fun|else|catch|try)\b.*:\s*$/.test(trimmedLine)
    );
}
