import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('FullTab Search command opens panel', async () => {
		await vscode.commands.executeCommand('fullTabSearch.open');
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('fullTabSearch.open'));
	});
});
