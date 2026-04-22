export function codeBlock(language: string, code: string): string {
    return `\`\`\`${language}\n${code}\n\`\`\``;
}

export function joinMarkdownSections(...sections: Array<string | undefined | null>): string {
    return sections.filter((section): section is string => Boolean(section && section.trim().length > 0)).join("\n\n");
}

export function inlineCode(code: string): string {
    return `\`${code.replace(/`/g, "\\`")}\``;
}
