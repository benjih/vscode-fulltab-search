import * as vscode from "vscode"

// Document-level edit operations behind the webview's edit mode. All edits
// are applied to the in-memory document (leaving it dirty, like typing in an
// editor) — persisting to disk is the caller's responsibility, via an
// explicit save. Line numbers are 1-based, matching search results.

/** Replaces the content of a single line. */
export async function applyLineEdit(
	file: string,
	line: number,
	newContent: string,
): Promise<vscode.Uri> {
	const uri = vscode.Uri.file(file)
	const document = await vscode.workspace.openTextDocument(uri)
	const target = document.lineAt(line - 1)
	const edit = new vscode.WorkspaceEdit()
	edit.replace(uri, target.range, newContent)
	await vscode.workspace.applyEdit(edit)
	return uri
}

/**
 * Splits a line in two, replacing it with `before` and `after` separated by
 * a line break that matches the document's EOL style.
 */
export async function applyLineSplit(
	file: string,
	line: number,
	before: string,
	after: string,
): Promise<vscode.Uri> {
	const uri = vscode.Uri.file(file)
	const document = await vscode.workspace.openTextDocument(uri)
	const target = document.lineAt(line - 1)
	const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n"
	const edit = new vscode.WorkspaceEdit()
	edit.replace(uri, target.range, `${before}${eol}${after}`)
	await vscode.workspace.applyEdit(edit)
	return uri
}

/**
 * Joins `line` into the line above it: both lines are replaced with
 * `mergedContent` (computed by the caller so it can include typing that has
 * not been committed to the document yet). Returns null without editing when
 * there is no line above.
 */
export async function applyLineJoin(
	file: string,
	line: number,
	mergedContent: string,
): Promise<vscode.Uri | null> {
	if (line < 2) return null
	const uri = vscode.Uri.file(file)
	const document = await vscode.workspace.openTextDocument(uri)
	const prevLine = document.lineAt(line - 2)
	const currLine = document.lineAt(line - 1)
	const edit = new vscode.WorkspaceEdit()
	edit.replace(
		uri,
		new vscode.Range(prevLine.range.start, currLine.range.end),
		mergedContent,
	)
	await vscode.workspace.applyEdit(edit)
	return uri
}
