import * as vscode from 'vscode';

function getWebviewContent(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Hello World</title>
	<style>
		body {
			font-family: var(--vscode-font-family);
			color: var(--vscode-foreground);
			background-color: var(--vscode-editor-background);
			padding: 2rem;
		}
		h1 {
			margin-top: 0;
		}
	</style>
</head>
<body>
	<h1>Hello World!</h1>
	<p>This is a custom webview tab, not a file.</p>
</body>
</html>`;
}

export function activate(context: vscode.ExtensionContext) {
	const disposable = vscode.commands.registerCommand('helloWorld.sayHello', () => {
		const panel = vscode.window.createWebviewPanel(
			'helloWorld',
			'Hello World',
			vscode.ViewColumn.One,
			{ enableScripts: true }
		);

		panel.webview.html = getWebviewContent();
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {}
