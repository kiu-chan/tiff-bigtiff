import * as vscode from 'vscode';
import { TiffEditorProvider } from './tiffEditor';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(TiffEditorProvider.register(context));
}

export function deactivate(): void {}
