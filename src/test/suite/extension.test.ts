import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Hello World command is registered', async () => {
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('helloWorld.sayHello'));
	});
});
